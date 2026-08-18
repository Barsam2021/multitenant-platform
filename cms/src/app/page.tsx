/**
 * Die Wurzel hat keinen Mandanten und kann deshalb nichts anzeigen. Jeder Kunde
 * bekommt seine eigene Adresse (cms.<domain>/<slug>) — wer hier landet, hat den
 * Slug vergessen.
 */
export default function RootPage() {
  return (
    <div className="login-wrap">
      <div className="panel login-card">
        <h1 style={{ fontSize: 18, marginTop: 0 }}>Redaktion</h1>
        <p className="muted">
          Diese Adresse ist unvollständig. Der Zugang zu Ihren Inhalten hat die Form{" "}
          <code>/name-ihres-projekts</code> — den vollständigen Link haben Sie von Ihrem Betreuer erhalten.
        </p>
      </div>
    </div>
  );
}
