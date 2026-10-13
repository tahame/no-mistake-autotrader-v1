import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, qs } from '../api';
import { Badge, Button, cx, Empty, ErrorText, Field, Loading, Modal, Money, MoneyInput, Select, Textarea, useToast } from '../components/ui';
import { rs, timeLabel } from '../format';
import { useScope } from '../session';

interface Modifier { id: string; name: string; price_delta_minor: number }
interface Group { id: string; name: string; min_select: number; max_select: number; modifiers: Modifier[] }
interface Variant { id: string; name: string; size_tag: string | null; price_minor: number; open_price: boolean }
interface Item { id: string; name: string; description: string | null; image: string | null; is_deal: boolean; variants: Variant[]; modifierGroups: Group[] }
interface Category { id: string; name: string; kind: string; items: Item[] }
interface CartLine { key: string; item: Item; variant: Variant; qty: number; mods: Modifier[]; openPriceMinor?: number }
interface Account { id: string; name: string; kind: string; location_id: string | null; active: boolean }
interface Order {
  id: string; order_no: number; status: string; total_minor: number; refunded_minor: number; created_at: string; void_reason: string | null;
  lines: { item: string; variant: string; qty: number; lineTotalMinor: number }[] | null;
  refunds: { amountMinor: number; reason: string; status: string }[] | null;
}

const unitPrice = (l: CartLine) => (l.variant.open_price ? l.openPriceMinor ?? 0 : l.variant.price_minor) + l.mods.reduce((a, m) => a + m.price_delta_minor, 0);

export function Pos() {
  const { orgId, locationId, location, can } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const menu = useQuery({ queryKey: ['menu', orgId, locationId], queryFn: () => get<Category[]>(`/orgs/${orgId}/menu${qs({ locationId })}`), enabled: !!locationId });
  const day = useQuery({ queryKey: ['day', orgId, locationId], queryFn: () => get<{ day: { id: string; business_date: string } | null }>(`/orgs/${orgId}/days/current${qs({ locationId })}`), enabled: !!locationId });
  const accounts = useQuery({ queryKey: ['accounts', orgId], queryFn: () => get<Account[]>(`/orgs/${orgId}/money-accounts`) });
  const [cat, setCat] = useState<string | null>(null);
  const [picking, setPicking] = useState<Item | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [account, setAccount] = useState('');
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());
  const [cartOpen, setCartOpen] = useState(false);
  const [showSales, setShowSales] = useState(false);

  const cats = menu.data ?? [];
  const current = cats.find((c) => c.id === cat) ?? cats[0];
  const total = cart.reduce((a, l) => a + unitPrice(l) * l.qty, 0);
  const count = cart.reduce((a, l) => a + l.qty, 0);
  const payAccounts = (accounts.data ?? []).filter((a) => a.active && (a.location_id === locationId || a.kind !== 'cash'));
  const cashDefault = payAccounts.find((a) => a.kind === 'cash' && a.location_id === locationId);
  const payWith = account || cashDefault?.id || '';

  const charge = useMutation({
    mutationFn: () => post<{ orderNo: number; totalMinor: number }>(`/orgs/${orgId}/orders`, {
      locationId, clientRef, paymentAccountId: payWith || null,
      lines: cart.map((l) => ({ variantId: l.variant.id, qty: l.qty, modifierIds: l.mods.map((m) => m.id), openPriceMinor: l.variant.open_price ? l.openPriceMinor : undefined })),
    }),
    onSuccess: (r) => {
      toast(`Sale #${r.orderNo} — ${rs(r.totalMinor)}`);
      setCart([]);
      setAccount('');
      setClientRef(crypto.randomUUID());
      setCartOpen(false);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['day'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });

  if (!location) return <Empty>No location is set up for you yet.</Empty>;
  if (menu.isLoading || day.isLoading) return <Loading />;
  if (!day.data?.day) {
    return (
      <div className="mx-auto max-w-md py-10 text-center">
        <div className="text-5xl">☀</div>
        <h1 className="mt-3 text-xl font-bold">The day is not open yet</h1>
        <p className="mt-2 text-[var(--muted)]">Open the day at {location.name} (enter the cash float) before ringing up sales.</p>
        {can('day.open') ? <Link to="/day"><Button variant="primary" size="lg" className="mt-5">Open the day</Button></Link> : null}
      </div>
    );
  }

  const addLine = (line: Omit<CartLine, 'key'>) => {
    setCart((c) => {
      const same = c.find((x) => x.variant.id === line.variant.id && !line.variant.open_price &&
        x.mods.map((m) => m.id).sort().join() === line.mods.map((m) => m.id).sort().join());
      if (same) return c.map((x) => (x === same ? { ...x, qty: x.qty + line.qty } : x));
      return [...c, { ...line, key: crypto.randomUUID() }];
    });
  };

  const cartPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Current sale</h2>
        {cart.length > 0 && <button className="text-sm text-[var(--muted)] underline" onClick={() => setCart([])}>Clear</button>}
      </div>
      <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
        {cart.length === 0 ? <Empty>Tap an item to start.</Empty> : cart.map((l) => (
          <div key={l.key} className="rounded-xl border border-[var(--line)] p-3">
            <div className="flex justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{l.item.name}</div>
                <div className="text-sm text-[var(--muted)]">{l.variant.open_price ? rs(l.openPriceMinor ?? 0) : l.variant.name}
                  {l.mods.length ? ` · ${l.mods.map((m) => m.name).join(', ')}` : ''}</div>
              </div>
              <Money minor={unitPrice(l) * l.qty} className="font-semibold" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={() => setCart((c) => c.flatMap((x) => (x === l ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x])))} aria-label="One less">−</Button>
              <span className="w-8 text-center font-semibold tabular">{l.qty}</span>
              <Button size="sm" onClick={() => setCart((c) => c.map((x) => (x === l ? { ...x, qty: x.qty + 1 } : x)))} aria-label="One more">+</Button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
        <Field label="Paid into">
          <Select value={payWith} onChange={(e) => setAccount(e.target.value)}
            options={payAccounts.map((a) => ({ value: a.id, label: a.kind === 'cash' ? `Cash — ${a.name}` : a.name }))} />
        </Field>
        <div className="flex items-baseline justify-between">
          <span className="text-[var(--muted)]">{count} item{count === 1 ? '' : 's'}</span>
          <span className="text-3xl font-bold tabular">{rs(total)}</span>
        </div>
        <Button variant="primary" size="lg" className="w-full" disabled={cart.length === 0} busy={charge.isPending} onClick={() => charge.mutate()}>
          Charge {rs(total)}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="lg:grid lg:grid-cols-[1fr_360px] lg:gap-5">
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">Sell</h1>
            <p className="text-sm text-[var(--muted)]">{location.name} · day of {day.data.day.business_date}</p>
          </div>
          <Button size="sm" onClick={() => setShowSales(true)}>Today's sales</Button>
        </div>
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCat(c.id)}
              className={cx('h-11 shrink-0 rounded-xl px-4 font-medium', current?.id === c.id ? 'bg-brand text-brand-ink' : 'bg-[var(--panel-2)]')}>
              {c.name}
            </button>
          ))}
        </div>
        {cats.length === 0 ? <Empty>Nothing on the menu is switched on for this location.</Empty> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {current?.items.map((it) => (
              <button key={it.id} onClick={() => setPicking(it)}
                className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] text-left transition active:scale-[0.98]">
                {it.image ? <img src={it.image} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="aspect-[4/3] bg-[var(--panel-2)]" />}
                <div className="p-3">
                  <div className="font-semibold leading-tight">{it.name}</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    {it.variants.length === 1 ? (it.variants[0]!.open_price ? 'Any amount' : rs(it.variants[0]!.price_minor))
                      : `${it.variants.length} sizes`}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className="sticky top-20 hidden h-[calc(100vh-7rem)] rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 lg:block">{cartPanel}</aside>

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-30 px-4 pb-2 lg:hidden">
          <Button variant="primary" size="lg" className="w-full shadow-lg" onClick={() => setCartOpen(true)}>
            {count} item{count === 1 ? '' : 's'} · {rs(total)} — Review & charge
          </Button>
        </div>
      )}
      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title="Current sale">{cartPanel}</Modal>

      {picking && <ItemPicker item={picking} onClose={() => setPicking(null)} onAdd={(l) => { addLine(l); setPicking(null); }} />}
      {showSales && <TodaysSales onClose={() => setShowSales(false)} dayId={day.data.day.id} accounts={payAccounts} />}
    </div>
  );
}

/** Tap a size, enter the count, pick any options. */
function ItemPicker({ item, onClose, onAdd }: { item: Item; onClose: () => void; onAdd: (l: Omit<CartLine, 'key'>) => void }) {
  const [variant, setVariant] = useState<Variant | null>(item.variants.length === 1 ? item.variants[0]! : null);
  const [qty, setQty] = useState('1');
  const [mods, setMods] = useState<Modifier[]>([]);
  const [amount, setAmount] = useState<number | null>(null);
  const n = Number(qty) || 0;
  const valid = variant && n >= 1 && n <= 1000 && (!variant.open_price || (amount ?? 0) > 0) &&
    item.modifierGroups.every((g) => mods.filter((m) => g.modifiers.some((x) => x.id === m.id)).length >= g.min_select);
  const toggle = (g: Group, m: Modifier) => setMods((cur) => {
    if (cur.some((x) => x.id === m.id)) return cur.filter((x) => x.id !== m.id);
    const inGroup = cur.filter((x) => g.modifiers.some((y) => y.id === x.id));
    if (inGroup.length >= g.max_select) return g.max_select === 1 ? [...cur.filter((x) => !inGroup.includes(x)), m] : cur;
    return [...cur, m];
  });
  // The count starts at 1; the first key typed replaces it.
  const [fresh, setFresh] = useState(true);
  const press = (k: string) => {
    if (k === '⌫') setQty((q) => q.slice(0, -1));
    else setQty((q) => (fresh ? k : q + k).replace(/^0+/, '').slice(0, 4));
    setFresh(false);
  };

  return (
    <Modal open onClose={onClose} title={item.name} wide footer={
      <Button variant="primary" size="lg" disabled={!valid} className="w-full sm:w-auto"
        onClick={() => variant && onAdd({ item, variant, qty: n, mods, openPriceMinor: variant.open_price ? amount ?? 0 : undefined })}>
        Add {n || ''} {variant ? `· ${rs(((variant.open_price ? amount ?? 0 : variant.price_minor) + mods.reduce((a, m) => a + m.price_delta_minor, 0)) * n)}` : ''}
      </Button>}>
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-sm font-medium">Size</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {item.variants.map((v) => (
              <button key={v.id} onClick={() => setVariant(v)}
                className={cx('min-h-16 rounded-xl border px-3 py-2 text-left', variant?.id === v.id ? 'border-brand bg-brand/20' : 'border-[var(--line)] bg-[var(--panel-2)]')}>
                <div className="font-semibold">{v.name}</div>
                <div className="text-sm text-[var(--muted)]">{v.open_price ? 'Custom amount' : `${rs(v.price_minor)}${v.size_tag && v.size_tag !== v.name ? ` · ${v.size_tag}` : ''}`}</div>
              </button>
            ))}
          </div>
          {variant?.open_price && (
            <div className="mt-3 max-w-xs"><Field label="Amount per plate"><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field></div>
          )}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium">How many?</span>
              <span className="text-3xl font-bold tabular">{qty || '0'}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                <button key={k} onClick={() => (k === 'C' ? (setQty(''), setFresh(false)) : press(k))}
                  className="h-14 rounded-xl bg-[var(--panel-2)] text-xl font-semibold active:bg-brand/30">{k}</button>
              ))}
            </div>
          </div>
          {item.modifierGroups.length > 0 && (
            <div className="space-y-4">
              {item.modifierGroups.map((g) => (
                <div key={g.id}>
                  <div className="mb-2 text-sm font-medium">{g.name} <span className="font-normal text-[var(--muted)]">
                    {g.min_select > 0 ? `(pick ${g.min_select})` : `(optional, up to ${g.max_select})`}</span></div>
                  <div className="flex flex-wrap gap-2">
                    {g.modifiers.map((m) => (
                      <button key={m.id} onClick={() => toggle(g, m)}
                        className={cx('h-11 rounded-xl border px-3 text-sm', mods.some((x) => x.id === m.id) ? 'border-brand bg-brand/20 font-semibold' : 'border-[var(--line)]')}>
                        {m.name}{m.price_delta_minor ? ` +${rs(m.price_delta_minor)}` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TodaysSales({ dayId, onClose, accounts }: { dayId: string; onClose: () => void; accounts: Account[] }) {
  const { orgId, locationId, can } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const orders = useQuery({ queryKey: ['orders', dayId], queryFn: () => get<Order[]>(`/orgs/${orgId}/orders${qs({ locationId, dayId })}`) });
  const [acting, setActing] = useState<{ order: Order; kind: 'void' | 'refund' } | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [refundTo, setRefundTo] = useState('');
  const act = useMutation({
    mutationFn: () => acting!.kind === 'void'
      ? post(`/orgs/${orgId}/orders/${acting!.order.id}/void`, { reason })
      : post(`/orgs/${orgId}/orders/${acting!.order.id}/refunds`, { amountMinor: amount, reason, accountId: refundTo || null }),
    onSuccess: () => {
      toast(acting!.kind === 'void' ? 'Sale voided' : 'Refund sent for approval');
      setActing(null); setReason(''); setAmount(null);
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
  const totals = useMemo(() => (orders.data ?? []).filter((o) => o.status === 'completed').reduce((a, o) => a + o.total_minor, 0), [orders.data]);

  return (
    <Modal open onClose={onClose} title="Today's sales" wide>
      {orders.isLoading ? <Loading /> : (
        <>
          <p className="mb-3 text-sm text-[var(--muted)]">{orders.data?.length ?? 0} sales · {rs(totals)} (voids excluded)</p>
          <div className="space-y-2">
            {(orders.data ?? []).map((o) => (
              <div key={o.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">#{o.order_no} <span className="font-normal text-[var(--muted)]">{timeLabel(o.created_at)}</span></div>
                    <div className="text-sm text-[var(--muted)]">{(o.lines ?? []).map((l) => `${l.qty}× ${l.item} ${l.variant}`).join(', ')}</div>
                    {o.status === 'voided' && <div className="mt-1"><Badge tone="bad">Voided: {o.void_reason}</Badge></div>}
                    {(o.refunds ?? []).map((r, i) => <div key={i} className="mt-1"><Badge tone="warn">Refund {rs(r.amountMinor)} · {r.status}</Badge></div>)}
                  </div>
                  <Money minor={o.total_minor} className={cx('font-semibold', o.status === 'voided' && 'line-through opacity-60')} />
                </div>
                {o.status === 'completed' && (can('pos.void') || can('pos.refund')) && (
                  <div className="mt-2 flex gap-2">
                    {can('pos.void') && o.refunded_minor === 0 && <Button size="sm" onClick={() => setActing({ order: o, kind: 'void' })}>Void</Button>}
                    {can('pos.refund') && <Button size="sm" onClick={() => { setAmount(o.total_minor - o.refunded_minor); setActing({ order: o, kind: 'refund' }); }}>Refund</Button>}
                  </div>
                )}
              </div>
            ))}
            {orders.data?.length === 0 && <Empty>No sales yet today.</Empty>}
          </div>
        </>
      )}
      {acting && (
        <Modal open onClose={() => setActing(null)} title={acting.kind === 'void' ? `Void sale #${acting.order.order_no}` : `Refund on sale #${acting.order.order_no}`}
          footer={<Button variant="danger" busy={act.isPending} disabled={reason.trim().length < 2 || (acting.kind === 'refund' && !amount)} onClick={() => act.mutate()}>
            {acting.kind === 'void' ? 'Void sale' : 'Request refund'}</Button>}>
          <div className="space-y-3">
            {acting.kind === 'refund' && (
              <>
                <Field label="Amount to refund"><MoneyInput value={amount} onChange={setAmount} /></Field>
                <Field label="Paid back from">
                  <Select value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder="Same account as the sale"
                    options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
                </Field>
                <p className="text-xs text-[var(--muted)]">A refund needs a partner's approval before it counts.</p>
              </>
            )}
            <Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. rang the wrong size" /></Field>
            <ErrorText error={act.error} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
