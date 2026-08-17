"use client";

import { useCallback, useEffect, useState, use } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Field {
  id: string;
  column_name: string;
  label: string;
  field_type: string;
  required: boolean;
  visible_list: boolean;
  visible_form: boolean;
  readonly: boolean;
  position: number;
}

interface Collection {
  id: string;
  table_name: string;
  label: string;
  sort_column: string | null;
  sort_dir: string;
  can_create: boolean;
  can_delete: boolean;
  fields: Field[];
}

interface CmsUser {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  disabled: boolean;
  last_login_at: string | null;
}

interface TableCandidate {
  name: string;
  rowEstimate: number;
  alreadyCollection: boolean;
}

// Muss zu cms/src/lib/fieldTypes.ts passen — dort steht, was der CMS-Dienst
// tatsächlich rendert.
const FIELD_TYPES = [
  { value: "text", label: "Text (einzeilig)" },
  { value: "textarea", label: "Text (mehrzeilig)" },
  { value: "richtext", label: "Formatierter Text" },
  { value: "number", label: "Zahl" },
  { value: "toggle", label: "Ja/Nein" },
  { value: "date", label: "Datum" },
  { value: "datetime", label: "Datum + Uhrzeit" },
  { value: "select", label: "Auswahl" },
  { value: "image", label: "Bild" },
  { value: "file", label: "Datei" },
  { value: "slug", label: "URL-Kürzel" },
  { value: "json", label: "JSON" },
  { value: "readonly", label: "Nur anzeigen" },
];

export default function CmsAdminPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [enabled, setEnabled] = useState(false);
  const [dbProvisioned, setDbProvisioned] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [users, setUsers] = useState<CmsUser[]>([]);
  const [tables, setTables] = useState<TableCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openCollection, setOpenCollection] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<boolean | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Collection | null>(null);
  const [newUser, setNewUser] = useState({ email: "", password: "", displayName: "" });
  const [showUserForm, setShowUserForm] = useState(false);
  const toast = useToast();

  const cmsUrl = typeof window !== "undefined" ? `${window.location.protocol}//cms.${window.location.host.replace(/^[^.]+\./, "")}/${slug}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stateRes, collectionsRes] = await Promise.all([
        fetch(`/api/tenants/${slug}/cms`).then((r) => r.json()),
        fetch(`/api/tenants/${slug}/cms/collections`).then((r) => r.json()),
      ]);
      if (stateRes.error) {
        toast.error(stateRes.error);
      } else {
        setEnabled(stateRes.enabled);
        setDbProvisioned(stateRes.dbProvisioned);
        setUsers(stateRes.users || []);
        setTables(stateRes.tables || []);
      }
      setCollections(collectionsRes.collections || []);
    } catch {
      toast.error("CMS-Konfiguration konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, [slug, toast]);

  useEffect(() => {
    load();
    // load haengt an toast, das bei jedem Render neu ist — bewusst nur beim
    // ersten Mal laden, alles weitere passiert nach Aktionen explizit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function handleToggle(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/cms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Umschalten fehlgeschlagen");
        return;
      }
      toast.success(next ? "CMS aktiviert." : "CMS deaktiviert — die Konfiguration bleibt erhalten.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addCollection(tableName: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/cms/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableName, label: tableName.replace(/_/g, " ") }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Sammlung konnte nicht angelegt werden");
        return;
      }
      toast.success(`"${tableName}" ist jetzt im CMS sichtbar.`);
      await load();
      setOpenCollection(data.collection?.id ?? null);
    } finally {
      setBusy(false);
    }
  }

  async function removeCollection(collection: Collection) {
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/cms/collections/${collection.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Entfernen fehlgeschlagen");
        return;
      }
      if (data.warning) toast.error(data.warning);
      else toast.success("Sammlung entfernt. Die Tabelle und ihre Daten bleiben unverändert.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function syncCollection(collection: Collection) {
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/cms/collections/${collection.id}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Abgleich fehlgeschlagen");
        return;
      }
      const parts: string[] = [];
      if (data.added?.length) parts.push(`${data.added.length} neu`);
      if (data.removed?.length) parts.push(`${data.removed.length} entfernt`);
      toast.success(parts.length ? `Felder abgeglichen: ${parts.join(", ")}.` : "Felder sind aktuell.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function patchCollection(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/tenants/${slug}/cms/collections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error("Änderung konnte nicht gespeichert werden");
      return;
    }
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } as Collection : c)));
  }

  async function patchField(fieldId: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/tenants/${slug}/cms/fields/${fieldId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error("Feld konnte nicht gespeichert werden");
      return;
    }
    const data = await res.json();
    setCollections((prev) =>
      prev.map((c) => ({ ...c, fields: c.fields.map((f) => (f.id === fieldId ? data.field : f)) }))
    );
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/cms/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUser),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Zugang konnte nicht angelegt werden");
        return;
      }
      toast.success(`Zugang für ${data.user.email} angelegt.`);
      setNewUser({ email: "", password: "", displayName: "" });
      setShowUserForm(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(id: string) {
    const res = await fetch(`/api/tenants/${slug}/cms/users/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Zugang konnte nicht gelöscht werden");
      return;
    }
    setUsers((prev) => prev.filter((u) => u.id !== id));
  }

  if (loading) return <div className="empty-state">Lade…</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>CMS</h2>
        <button
          className={enabled ? "btn" : "btn btn-primary"}
          onClick={() => setToggleTarget(!enabled)}
          disabled={busy || (!enabled && !dbProvisioned)}
        >
          {enabled ? "CMS deaktivieren" : "CMS aktivieren"}
        </button>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderLeft: `3px solid ${enabled ? "#2da44e" : "var(--border)"}`,
          borderRadius: 8,
          padding: 14,
          marginBottom: 20,
          background: "var(--panel)",
          fontSize: 13,
        }}
      >
        {!dbProvisioned ? (
          <>
            <strong>Keine Datenbank vorhanden.</strong>
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
              Das CMS speichert Inhalte in den Tabellen der Kundendatenbank. Erst im Tab „Übersicht“ unter
              „Datenbank &amp; Auth“ einschalten — laufende Container braucht das CMS nicht, nur die Datenbank selbst.
            </div>
          </>
        ) : enabled ? (
          <>
            <strong>CMS ist aktiv.</strong>
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
              Der Kunde meldet sich an unter{" "}
              <a href={cmsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {cmsUrl}
              </a>
              . Zugriff hat er ausschließlich auf die unten freigegebenen Sammlungen — das ist auf Datenbankebene
              erzwungen, nicht nur in der Oberfläche.
            </div>
          </>
        ) : (
          <>
            <strong>CMS ist nicht aktiv.</strong>
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
              Beim Aktivieren wird eine eingeschränkte Datenbankrolle <code>cms_{slug}</code> angelegt. Sie bekommt
              Rechte ausschließlich auf die Tabellen, die hier als Sammlung freigegeben werden.
            </div>
          </>
        )}
      </div>

      {enabled && (
        <>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Sammlungen</h3>
          {collections.length === 0 && (
            <div className="empty-state" style={{ marginBottom: 12 }}>
              Noch keine Sammlung freigegeben — unten eine Tabelle auswählen.
            </div>
          )}

          {collections.map((collection) => {
            const open = openCollection === collection.id;
            return (
              <div
                key={collection.id}
                style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", padding: 12, marginBottom: 8 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <input
                      value={collection.label}
                      onChange={(e) =>
                        setCollections((prev) =>
                          prev.map((c) => (c.id === collection.id ? { ...c, label: e.target.value } : c))
                        )
                      }
                      onBlur={(e) => patchCollection(collection.id, { label: e.target.value })}
                      style={{ fontWeight: 600, width: 220 }}
                    />
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                      Tabelle <code>{collection.table_name}</code> · {collection.fields.length} Felder
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn" onClick={() => setOpenCollection(open ? null : collection.id)}>
                      {open ? "Felder verbergen" : "Felder bearbeiten"}
                    </button>
                    <button className="btn" onClick={() => syncCollection(collection)} disabled={busy}>
                      Schema abgleichen
                    </button>
                    <button className="btn btn-danger" onClick={() => setRemoveTarget(collection)} disabled={busy}>
                      Entfernen
                    </button>
                  </div>
                </div>

                {open && (
                  <div style={{ marginTop: 12, overflowX: "auto" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        Sortieren nach
                        <select
                          value={collection.sort_column || ""}
                          onChange={(e) => patchCollection(collection.id, { sort_column: e.target.value || null })}
                        >
                          <option value="">—</option>
                          {collection.fields.map((f) => (
                            <option key={f.id} value={f.column_name}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        Richtung
                        <select
                          value={collection.sort_dir}
                          onChange={(e) => patchCollection(collection.id, { sortDir: e.target.value, sort_dir: e.target.value })}
                        >
                          <option value="desc">absteigend</option>
                          <option value="asc">aufsteigend</option>
                        </select>
                      </label>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={collection.can_create}
                          onChange={(e) => patchCollection(collection.id, { canCreate: e.target.checked, can_create: e.target.checked })}
                          style={{ width: "auto" }}
                        />
                        Anlegen erlaubt
                      </label>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={collection.can_delete}
                          onChange={(e) => patchCollection(collection.id, { canDelete: e.target.checked, can_delete: e.target.checked })}
                          style={{ width: "auto" }}
                        />
                        Löschen erlaubt
                      </label>
                    </div>

                    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                          <th style={{ padding: "4px 6px" }}>Spalte</th>
                          <th style={{ padding: "4px 6px" }}>Beschriftung</th>
                          <th style={{ padding: "4px 6px" }}>Typ</th>
                          <th style={{ padding: "4px 6px" }}>Liste</th>
                          <th style={{ padding: "4px 6px" }}>Formular</th>
                          <th style={{ padding: "4px 6px" }}>Pflicht</th>
                        </tr>
                      </thead>
                      <tbody>
                        {collection.fields.map((field) => (
                          <tr key={field.id} style={{ borderTop: "1px solid var(--border)" }}>
                            <td style={{ padding: "4px 6px" }}>
                              <code>{field.column_name}</code>
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              <input
                                defaultValue={field.label}
                                onBlur={(e) => patchField(field.id, { label: e.target.value })}
                                style={{ width: 160 }}
                              />
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              <select
                                value={field.field_type}
                                onChange={(e) => patchField(field.id, { fieldType: e.target.value })}
                              >
                                {FIELD_TYPES.map((t) => (
                                  <option key={t.value} value={t.value}>
                                    {t.label}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              <input
                                type="checkbox"
                                checked={field.visible_list}
                                onChange={(e) => patchField(field.id, { visibleList: e.target.checked })}
                                style={{ width: "auto" }}
                              />
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              <input
                                type="checkbox"
                                checked={field.visible_form}
                                onChange={(e) => patchField(field.id, { visibleForm: e.target.checked })}
                                style={{ width: "auto" }}
                              />
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              <input
                                type="checkbox"
                                checked={field.required}
                                onChange={(e) => patchField(field.id, { required: e.target.checked })}
                                style={{ width: "auto" }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", padding: 12, marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tabelle freigeben</div>
            {tables.filter((t) => !t.alreadyCollection).length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Alle Tabellen dieser Datenbank sind bereits freigegeben.
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {tables
                  .filter((t) => !t.alreadyCollection)
                  .map((t) => (
                    <button key={t.name} className="btn" onClick={() => addCollection(t.name)} disabled={busy}>
                      + {t.name}{" "}
                      <span style={{ color: "var(--text-faint)" }}>
                        (~{t.rowEstimate} {t.rowEstimate === 1 ? "Zeile" : "Zeilen"})
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Zugänge</h3>
            <button className="btn" onClick={() => setShowUserForm((v) => !v)}>
              {showUserForm ? "Abbrechen" : "+ Zugang anlegen"}
            </button>
          </div>

          {showUserForm && (
            <form
              onSubmit={createUser}
              style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)" }}
            >
              <input
                type="email"
                placeholder="E-Mail"
                value={newUser.email}
                onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
                required
              />
              <input
                placeholder="Name (optional)"
                value={newUser.displayName}
                onChange={(e) => setNewUser((u) => ({ ...u, displayName: e.target.value }))}
              />
              <input
                type="text"
                placeholder="Passwort (min. 12 Zeichen)"
                value={newUser.password}
                onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))}
                minLength={12}
                required
                style={{ minWidth: 220 }}
              />
              <button className="btn btn-primary" type="submit" disabled={busy}>
                Anlegen
              </button>
              <span style={{ fontSize: 11, color: "var(--text-faint)", flexBasis: "100%" }}>
                Das Passwort wird nur beim Anlegen im Klartext angezeigt — danach ist es gehasht gespeichert und nur
                noch neu setzbar. Am besten direkt an den Kunden weitergeben.
              </span>
            </form>
          )}

          {users.length === 0 ? (
            <div className="empty-state">Noch kein Zugang angelegt — ohne den kann sich niemand am CMS anmelden.</div>
          ) : (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)" }}>
              {users.map((user) => (
                <div
                  key={user.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 8 }}
                >
                  <div style={{ fontSize: 13 }}>
                    {user.email}
                    {user.display_name && <span style={{ color: "var(--text-dim)" }}> · {user.display_name}</span>}
                    <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {user.disabled ? "gesperrt" : "aktiv"} ·{" "}
                      {user.last_login_at
                        ? `zuletzt angemeldet ${new Date(user.last_login_at).toLocaleString("de-DE")}`
                        : "noch nie angemeldet"}
                    </div>
                  </div>
                  <button className="btn btn-danger" onClick={() => deleteUser(user.id)}>
                    Löschen
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => toggleTarget !== null && handleToggle(toggleTarget)}
        title={toggleTarget ? "CMS aktivieren" : "CMS deaktivieren"}
        description={
          toggleTarget
            ? `Legt die eingeschränkte Datenbankrolle cms_${slug} an. Ohne freigegebene Sammlung sieht sie noch nichts.`
            : `Entfernt die Datenbankrolle cms_${slug} — der Kunde kann sich nicht mehr anmelden. Sammlungen, Felder und Zugänge bleiben gespeichert und sind beim erneuten Aktivieren sofort wieder da. Inhalte werden nicht angefasst.`
        }
        confirmLabel={toggleTarget ? "Aktivieren" : "Deaktivieren"}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && removeCollection(removeTarget)}
        title="Sammlung entfernen"
        description={
          removeTarget
            ? `"${removeTarget.label}" verschwindet aus dem CMS und die Datenbankrolle verliert ihre Rechte auf die Tabelle "${removeTarget.table_name}". Die Tabelle und alle Daten darin bleiben unverändert.`
            : ""
        }
        confirmLabel="Entfernen"
      />
    </div>
  );
}
