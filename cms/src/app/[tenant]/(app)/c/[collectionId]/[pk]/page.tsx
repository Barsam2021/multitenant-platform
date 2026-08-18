import { notFound } from "next/navigation";
import { getCollectionWithFields } from "@/lib/configDb";
import { getRow } from "@/lib/rows";
import { RowForm } from "@/components/RowForm";

export default async function EditRowPage({
  params,
}: {
  params: Promise<{ tenant: string; collectionId: string; pk: string }>;
}) {
  const { tenant: tenantSlug, collectionId, pk } = await params;
  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) notFound();
  const { collection, fields } = found;

  const row = await getRow(tenantSlug, collection.table_name, fields, decodeURIComponent(pk));
  if (!row) notFound();

  // readonly-Felder bleiben sichtbar (id, Erstellungsdatum — die will man beim
  // Bearbeiten oft sehen), sind aber gesperrt; der Server ignoriert sie ohnehin.
  const formFields = fields.filter((f) => f.visible_form);

  return (
    <div>
      <div className="page-head">
        <h1>{collection.label_singular || collection.label} bearbeiten</h1>
      </div>
      <RowForm
        tenantSlug={tenantSlug}
        collectionId={collectionId}
        collectionLabel={collection.label}
        fields={formFields}
        row={row}
        pk={decodeURIComponent(pk)}
        canDelete={collection.can_delete}
      />
    </div>
  );
}
