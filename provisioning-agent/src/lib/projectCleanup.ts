import { execFile } from 'child_process';
import { promisify } from 'util';
import { BUILDS_ROOT } from './git';
import { deleteGithubWebhook } from './github';
import { removeAllRoutersForProject } from './traefikDynamic';
import { deleteMonitor, isMonitoringConfigured } from './monitoring';

const execFileP = promisify(execFile);

/**
 * Alles wegraeumen, was zu EINEM Projekt gehoert — ausser den DB-Zeilen, die
 * der Aufrufer loescht (er weiss, ob gerade ein Projekt oder ein ganzer Tenant
 * dran ist).
 *
 * Warum das ein eigenes Modul ist: bis hierher hat NIEMAND diese Dinge
 * aufgeraeumt. Das Loeschen eines Kunden entfernte Datenbank, MinIO-Bucket und
 * Tenant-Container, liess aber Build-Cache, App-Container, Images, das
 * Projekt-Netz und den GitHub-Webhook stehen. Sichtbar wurde das erst beim
 * naechsten Kunden mit demselben Slug: der erbte den alten Klon und bekam
 * kommentarlos das Projekt seines Vorgaengers ausgeliefert.
 *
 * Jeder Schritt ist einzeln fehlertolerant — ein Projekt, das nie deployt
 * wurde, hat naturgemaess weder Container noch Image, und daran darf das
 * Loeschen nicht scheitern.
 */
export interface ProjectRef {
  slug: string;
  repo_url?: string | null;
  github_webhook_id?: number | null;
  kuma_monitor_id?: number | null;
}

export async function cleanupProjectResources(project: ProjectRef): Promise<string[]> {
  const warnings: string[] = [];
  const slug = project.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return [`Ungueltiger Projekt-Slug "${slug}" — nichts aufgeraeumt.`];
  }

  // 1. Container. Zwei Filter statt einem: "^/app-<slug>$" trifft den
  //    oeffentlichen Container, "^/app-<slug>-" die geparkten und die
  //    Kandidaten aus abgebrochenen Deploys. Ein blosses "app-<slug>" wuerde
  //    zusaetzlich app-<slug>2 eines FREMDEN Projekts erwischen.
  for (const filter of [`^/app-${slug}$`, `^/app-${slug}-`]) {
    try {
      const { stdout } = await execFileP('docker', ['ps', '-aq', '--filter', `name=${filter}`]);
      for (const id of stdout.trim().split('\n').filter(Boolean)) {
        await execFileP('docker', ['rm', '-f', id]).catch((e: any) =>
          warnings.push(`Container ${id} entfernen fehlgeschlagen: ${e.message}`)
        );
      }
    } catch (e: any) {
      warnings.push(`Container-Suche (${filter}) fehlgeschlagen: ${e.message}`);
    }
  }

  // 2. Traefik-Router (Preview- und Custom-Domains).
  await removeAllRoutersForProject(slug).catch((e: any) =>
    warnings.push(`Traefik-Router entfernen fehlgeschlagen: ${e.message}`)
  );

  // 3. Projekt-Netz. Traefik, der Agent und die Tenant-Dienste haengen noch
  //    darin — ohne sie vorher zu loesen scheitert `network rm` mit "has active
  //    endpoints".
  const netName = `app-${slug}-net`;
  try {
    const { stdout } = await execFileP('docker', [
      'network', 'inspect', netName, '--format', '{{range .Containers}}{{.Name}} {{end}}',
    ]);
    for (const container of stdout.trim().split(/\s+/).filter(Boolean)) {
      await execFileP('docker', ['network', 'disconnect', '-f', netName, container]).catch(() => {});
    }
    await execFileP('docker', ['network', 'rm', netName]);
  } catch (e: any) {
    // "No such network" ist der Normalfall bei nie deployten Projekten.
    if (!/No such network|not found/i.test(e.stderr || e.message || '')) {
      warnings.push(`Netzwerk ${netName} entfernen fehlgeschlagen: ${e.message}`);
    }
  }

  // 4. Images app-<slug>:<sha>.
  try {
    const { stdout } = await execFileP('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    const images = stdout.trim().split('\n').filter((img) => img.startsWith(`app-${slug}:`));
    for (const img of images) {
      await execFileP('docker', ['rmi', img]).catch((e: any) =>
        warnings.push(`Image ${img} entfernen fehlgeschlagen: ${e.message}`)
      );
    }
  } catch (e: any) {
    warnings.push(`Image-Suche fehlgeschlagen: ${e.message}`);
  }

  // 5. Build-Verzeichnis — der eigentliche Ausloeser dieses Moduls: hier liegt
  //    der Git-Klon, den ein gleichnamiges Nachfolgeprojekt sonst weiterbenutzt.
  await execFileP('rm', ['-rf', `${BUILDS_ROOT}/${slug}`]).catch((e: any) =>
    warnings.push(`Build-Verzeichnis entfernen fehlgeschlagen: ${e.message}`)
  );

  // 6. GitHub-Webhook.
  if (project.github_webhook_id && project.repo_url) {
    const result = await deleteGithubWebhook(project.repo_url, project.github_webhook_id);
    if (!result.deleted) {
      warnings.push(
        `GitHub-Webhook ${project.github_webhook_id} nicht entfernt (${result.reason}) — ` +
        `im Repo unter Settings > Webhooks manuell loeschen.`
      );
    }
  }

  // 7. Uptime-Kuma-Monitor.
  if (project.kuma_monitor_id && isMonitoringConfigured()) {
    await deleteMonitor(project.kuma_monitor_id).catch((e: any) =>
      warnings.push(`Monitor ${project.kuma_monitor_id} entfernen fehlgeschlagen: ${e.message}`)
    );
  }

  return warnings;
}
