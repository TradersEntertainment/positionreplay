/**
 * SPEC §4.6 step 3: map each symbol to a price source.
 *
 * "Provide a symbol-mapping step (BTC -> BTCUSDT). If mapping fails or the symbol is
 * unknown, fall back to letting the user upload their own OHLCV CSV." Both live on the
 * same form: one text field per symbol, one file field per symbol.
 *
 * This does not change the document id — `documentIdFor` hashes the file and its
 * column mapping, not the price sources — so the link handed out at the previous step
 * keeps working.
 */

import { NextResponse } from 'next/server';
import { UploadError, getDocument, putDocument, symbolsFromForm, viewFor } from '../../../../lib/csv';

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

  try {
    const { symbols } = viewFor(existing);
    const sources = await symbolsFromForm(form, symbols);
    await putDocument(
      existing.filename,
      existing.text,
      existing.mapping,
      sources,
      existing.createdAt,
    );
    return NextResponse.redirect(new URL(`/a/csv/${existing.id}`, request.url), 303);
  } catch (error) {
    const message = error instanceof UploadError ? error.message : 'The symbols could not be saved.';
    return NextResponse.redirect(
      new URL(`/csv/${existing.id}?error=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }
}
