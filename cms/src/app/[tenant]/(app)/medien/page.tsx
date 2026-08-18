import { listMedia, usedStorageBytes } from "@/lib/configDb";
import { MAX_STORAGE_BYTES } from "@/lib/media";
import { MediaUploader } from "@/components/MediaUploader";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function MediaPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;
  const [media, used] = await Promise.all([listMedia(tenantSlug), usedStorageBytes(tenantSlug)]);

  return (
    <div>
      <div className="page-head">
        <h1>Bilder &amp; Dateien</h1>
        <span className="muted">
          {formatBytes(used)} von {formatBytes(MAX_STORAGE_BYTES)} belegt
        </span>
      </div>

      <MediaUploader tenantSlug={tenantSlug} />

      {media.length === 0 ? (
        <div className="empty-state">Noch nichts hochgeladen.</div>
      ) : (
        <div className="media-grid">
          {media.map((item) => (
            <div key={item.id} className="media-tile">
              {item.content_type.startsWith("image/") ? (
                <a href={item.public_url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.public_url} alt={item.original_name || ""} />
                </a>
              ) : (
                <a
                  href={item.public_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  PDF
                </a>
              )}
              <div className="meta">
                {item.original_name || item.object_key.split("/").pop()}
                <br />
                {formatBytes(Number(item.size_bytes))}
                {item.width && item.height && ` · ${item.width}×${item.height}`}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: 20 }}>
        Hochgeladene Bilder werden automatisch verkleinert und in ein platzsparendes Format umgewandelt. Aufnahmeort
        und Kameradaten aus Handyfotos werden dabei entfernt.
      </p>
    </div>
  );
}
