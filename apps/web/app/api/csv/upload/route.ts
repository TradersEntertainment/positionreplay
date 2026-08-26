/**
 * SPEC §4.6 step 1: accept the file.
 *
 * A route handler rather than a server action because the whole flow is plain forms —
 * it works with JavaScript disabled, and Playwright drives it the same way a person
 * would.
 */

import { NextResponse } from 'next/server';
import { UploadError, initialMapping, putDocument, readUpload } from '../../../../lib/csv';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const { filename, text } = await readUpload(form.get('file'));

    // The suggestion is a starting point, never a commitment: the next page shows it
    // and lets every column be changed, which is what §4.6 means by "map columns via
    // a UI step (don't hard-require header names)".
    const document = await putDocument(filename, text, initialMapping(text), {}, Date.now());

    return NextResponse.redirect(new URL(`/csv/${document.id}`, request.url), 303);
  } catch (error) {
    const message =
      error instanceof UploadError || error instanceof Error
        ? error.message
        : 'The file could not be read.';
    return NextResponse.redirect(
      new URL(`/?csvError=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }
}
