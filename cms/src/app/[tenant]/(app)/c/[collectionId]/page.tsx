import Link from "next/link";
import { notFound } from "next/navigation";
import { getCollectionWithFields } from "@/lib/configDb";
import { listRows } from "@/lib/rows";

const PAGE_SIZE = 25;

/** Zellwert kurz und lesbar — die Liste ist eine Übersicht, kein Datenblatt. */
function preview(value: unknown, fieldType: string): string {
  if (value === null || value === undefined) return "—";
  if (fieldType === "toggle") return value ? "Ja" : "Nein";
  if (value instanceof Date) return value.toLocaleString("de-DE");
  if (fieldType === "richtext") {
    const text = String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 80)}…` : text || "—";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; collectionId: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { tenant: tenantSlug, collectionId } = await params;
  const { page: pageParam, q } = await searchParams;

  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) notFound();
  const { collection, fields } = found;

  const page = Math.max(1, Number(pageParam) || 1);
  const listFields = fields.filter((f) => f.visible_list);

  let result;
  let error: string | null = null;
  try {
    result = await listRows(tenantSlug, collection.table_name, fields, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      sortColumn: collection.sort_column,
      sortDir: collection.sort_dir,
      search: q,
    });
  } catch (err) {
    error = (err as Error).message;
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <div className="page-head">
        <h1>{collection.label}</h1>
        {collection.can_create && (
          <Link href={`/${tenantSlug}/c/${collectionId}/neu`} className="btn btn-primary">
            + {collection.label_singular || "Eintrag"} anlegen
          </Link>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <form method="get" style={{ display: "flex", gap: 8, marginBottom: 16, maxWidth: 420 }}>
        <input name="q" placeholder="Suchen…" defaultValue={q || ""} />
        <button className="btn" type="submit">
          Suchen
        </button>
      </form>

      {result && result.rows.length === 0 && (
        <div className="empty-state">
          {q ? `Nichts gefunden für „${q}“.` : "Noch keine Einträge."}
        </div>
      )}

      {result && result.rows.length > 0 && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="rows">
              <thead>
                <tr>
                  {listFields.map((f) => (
                    <th key={f.id}>{f.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const pk = String(row[result.primaryKey]);
                  return (
                    <tr key={pk}>
                      {listFields.map((f) => (
                        <td key={f.id}>
                          {f.field_type === "image" && row[f.column_name] ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={String(row[f.column_name])}
                              alt=""
                              style={{ height: 40, borderRadius: 4 }}
                            />
                          ) : (
                            preview(row[f.column_name], f.field_type)
                          )}
                        </td>
                      ))}
                      <td style={{ textAlign: "right" }}>
                        <Link href={`/${tenantSlug}/c/${collectionId}/${encodeURIComponent(pk)}`} className="btn">
                          Bearbeiten
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <span className="muted">
              {result.total} {result.total === 1 ? "Eintrag" : "Einträge"}
            </span>
            {totalPages > 1 && (
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {page > 1 && (
                  <Link className="btn" href={`?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                    Zurück
                  </Link>
                )}
                <span className="muted">
                  Seite {page} von {totalPages}
                </span>
                {page < totalPages && (
                  <Link className="btn" href={`?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                    Weiter
                  </Link>
                )}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
