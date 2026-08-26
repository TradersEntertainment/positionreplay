/**
 * SPEC §4.6 step 2: confirm the column mapping.
 *
 * Confirming produces a *new* document id, because the id hashes the file together
 * with its mapping. That is deliberate: two mappings of one file are two different
 * reconstructions, and each deserves its own shareable link rather than one link whose
 * meaning silently changes.
 */

import { NextResponse } from 'next/server';
import { parseCsv } from '@trade-replay/adapters';
import { getDocument, mappingFromForm, putDocument } from '../../../../lib/csv';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');

  const existing = await getDocument(id);
  if (!existing) {
    return NextResponse.redirect(
      new URL('/?csvError=That+upload+is+no+longer+stored.+Upload+the+file+again.', request.url),
      303,
    );
  }

  const table = parseCsv(existing.text);
  const mapping = mappingFromForm(form, table.header.length);
  const document = await putDocument(
    existing.filename,
    existing.text,
    mapping,
    // Symbol sources are keyed by symbol, and a remap can rename the symbol column
    // entirely, so they are not carried across. The next step re-asks.
    {},
    existing.createdAt,
  );

  return NextResponse.redirect(new URL(`/csv/${document.id}`, request.url), 303);
}
