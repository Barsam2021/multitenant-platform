/**
 * Erkennt bekannte, wiederkehrende Build-Fehlerklassen im rohen Nixpacks/Docker-Log
 * und liefert einen kurzen Klartext-Hinweis dafür — landet als Banner ganz oben im
 * `build_log`, damit man nicht erst durch hunderte Zeilen Nix-Paket-Output scrollen
 * muss (siehe Deploy-Debugging für up2-site, 03.08.2026).
 *
 * Bewusst nur additiv: Rohes Log bleibt vollständig erhalten, das hier ist nur ein
 * vorangestellter Hinweis, keine Ersetzung.
 */
export function detectBuildErrorHint(log: string): string | null {
  if (/Node\.js version ">?=?[\d.]+.*is required/i.test(log) || /You are using Node\.js [\d.]+\. For .* Node\.js version/i.test(log)) {
    return 'Node-Version zu alt für dieses Framework. Fix im App-Repo: .nvmrc oder "engines.node" in package.json auf eine neuere Version setzen.';
  }
  if (/npm ERR!.*ERESOLVE/i.test(log)) {
    return 'npm-Dependency-Konflikt (ERESOLVE). Fix im App-Repo: package-lock.json neu generieren oder Versionskonflikt in package.json auflösen.';
  }
  if (/npm ERR! missing script: (build|start)/i.test(log)) {
    return 'package.json hat kein "build"- oder "start"-Script. Fix im App-Repo: Script ergänzen oder Custom-Build-Command im Projekt setzen.';
  }
  if (/Cannot find module|Module not found/i.test(log)) {
    return 'Fehlendes Modul beim Build. Fix im App-Repo: fehlende Dependency in package.json ergänzen.';
  }
  return null;
}
