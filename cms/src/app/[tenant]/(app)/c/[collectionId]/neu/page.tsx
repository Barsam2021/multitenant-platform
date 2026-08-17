import { notFound, redirect } from "next/navigation";
import { getCollectionWithFields } from "@/lib/configDb";
import { RowForm } from "@/components/RowForm";

export default async function NewRowPage({
  params,
}: {
  params: Promise<{ tenant: string; collectionId: string }>;
}) {
  const { tenant: tenantSlug, collectionId } = await params;
  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) notFound();
  const { collection, fields } = found;
  // can_create ist eine Entscheidung des Betreibers — sie hier zu ignorieren
  // wuerde die Einstellung im Dashboard zur Dekoration machen.
  if (!collection.can_create) redirect(`/${tenantSlug}/c/${collectionId}`);

  const formFields = fields.filter((f) => f.visible_form && !f.readonly);

  return (
    <div>
      <div className="page-head">
        <h1>{collection.label_singular || collection.label} anlegen</h1>
      </div>
      <RowForm
        tenantSlug={tenantSlug}
        collectionId={collectionId}
        collectionLabel={collection.label}
        fields={formFields}
        row={null}
        pk={null}
        canDelete={false}
      />
    </div>
  );
}
