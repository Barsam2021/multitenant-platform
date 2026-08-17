import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { updateField } from "@/lib/cmsDb";

// PATCH — Darstellung eines Feldes ändern (Beschriftung, Typ, Sichtbarkeit).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; fieldId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, fieldId } = await params;
  const patch = await req.json();
  const updated = await updateField(fieldId, slug, {
    label: patch.label,
    field_type: patch.fieldType,
    help_text: patch.helpText,
    required: patch.required,
    visible_list: patch.visibleList,
    visible_form: patch.visibleForm,
    readonly: patch.readonly,
    position: patch.position,
  });
  if (!updated) return NextResponse.json({ error: "field not found" }, { status: 404 });
  return NextResponse.json({ field: updated });
}
