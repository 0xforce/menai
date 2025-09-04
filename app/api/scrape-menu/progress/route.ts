import { NextResponse } from "next/server";

// Reuse the in-memory store by global accessor

type ProgressRecord = any;

function getProgressStore(): Map<string, ProgressRecord> {
  // @ts-ignore
  const g = globalThis as any;
  if (!g.__MENAI_PROGRESS__) g.__MENAI_PROGRESS__ = new Map<string, ProgressRecord>();
  return g.__MENAI_PROGRESS__;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const cleanup = searchParams.get('cleanup') === 'true';
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
    const store = getProgressStore();
    const rec = store.get(id);
    if (!rec) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    if (cleanup && (rec.status === 'completed' || rec.status === 'error' || rec.status === 'cancelled')) {
      store.delete(id);
      return NextResponse.json({ ok: true, cleaned: true, id });
    }
    return NextResponse.json(rec);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = body?.id ? String(body.id) : undefined;
    const action = body?.action ? String(body.action) : undefined;
    if (!id || !action) return NextResponse.json({ error: 'missing id or action' }, { status: 400 });
    const store = getProgressStore();
    const rec = store.get(id);
    if (!rec) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    if (action === 'cancel') {
      rec.cancelRequested = true;
      rec.message = 'cancelled';
      rec.stage = 'cancelled';
      rec.status = 'cancelled';
      store.set(id, { ...rec });
      return NextResponse.json({ ok: true, id, status: 'cancelled' });
    }
    return NextResponse.json({ error: 'unsupported_action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
