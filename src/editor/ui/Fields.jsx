// Form widgets shared by the inspector and every panel (schema-driven).
import { useState, useEffect } from 'preact/hooks';

export function Row({ label, children, title }) {
  return <label class="row" title={title}><span class="lbl">{label}</span><span class="val">{children}</span></label>;
}

export function NumberField({ value, onChange, step = 0.1, min, max }) {
  const [txt, setTxt] = useState(value ?? '');
  useEffect(() => setTxt(value ?? ''), [value]);
  const commit = (v) => { const n = Number(v); if (v === '' || Number.isNaN(n)) return; onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n); };
  // drag on the field to scrub the value
  const onDown = (e) => {
    if (e.button !== 0 || document.activeElement === e.target) return;
    const x0 = e.clientX, v0 = Number(value) || 0;
    let moved = false;
    const mv = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true; if (moved) commit((v0 + dx * step).toFixed(3)); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (!moved) e.target.focus(); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    e.preventDefault();
  };
  return <input class="num" type="text" value={txt} onPointerDown={onDown} onInput={(e) => setTxt(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { commit(e.target.value); e.target.blur(); } }} />;
}

export function TextField({ value, onChange, placeholder, multiline }) {
  const [txt, setTxt] = useState(value ?? '');
  useEffect(() => setTxt(value ?? ''), [value]);
  if (multiline) return <textarea value={txt} placeholder={placeholder} onInput={(e) => setTxt(e.target.value)} onBlur={() => txt !== (value ?? '') && onChange(txt)} />;
  return <input type="text" value={txt} placeholder={placeholder} onInput={(e) => setTxt(e.target.value)} onBlur={() => txt !== (value ?? '') && onChange(txt)} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />;
}

export function Vec3Field({ value = [0, 0, 0], onChange, step = 0.1 }) {
  return (
    <span class="vec3">
      {[0, 1, 2].map((i) => <NumberField key={i} step={step} value={value?.[i] ?? 0} onChange={(v) => { const n = [...(value ?? [0, 0, 0])]; n[i] = v; onChange(n); }} />)}
    </span>
  );
}

export function BoolField({ value, onChange }) {
  return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
}

export function EnumField({ value, options, onChange, allowEmpty }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
      {allowEmpty && <option value="">—</option>}
      {options.map((o) => (typeof o === 'string' ? <option value={o}>{o}</option> : <option value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function ColorField({ value, onChange }) {
  return <span class="color"><input type="color" value={value ?? '#888888'} onInput={(e) => onChange(e.target.value)} /><code>{value}</code></span>;
}

export function JsonField({ value, onChange, rows = 6 }) {
  const [txt, setTxt] = useState(JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState(null);
  useEffect(() => setTxt(JSON.stringify(value ?? null, null, 2)), [JSON.stringify(value)]);
  return (
    <span class="json">
      <textarea rows={rows} value={txt} class={err ? 'bad' : ''} onInput={(e) => { setTxt(e.target.value); try { JSON.parse(e.target.value); setErr(null); } catch (x) { setErr(x.message); } }} onBlur={() => { try { onChange(JSON.parse(txt)); } catch { /* keep */ } }} />
      {err && <small class="err">{err}</small>}
    </span>
  );
}

export function ListField({ value = [], onChange }) {
  return <TextField value={(value ?? []).join(', ')} onChange={(t) => onChange(t.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="a, b, c" />;
}

/** Field for a schema entry ({ type, label, options, ... }); ctx gives lists for pickers. */
export function SchemaField({ f, value, onChange, ctx }) {
  switch (f.type) {
    case 'number': case 'int': return <NumberField value={value} step={f.step ?? (f.type === 'int' ? 1 : 0.1)} min={f.min} max={f.max} onChange={(v) => onChange(f.type === 'int' ? Math.round(v) : v)} />;
    case 'string': return <TextField value={value} onChange={onChange} />;
    case 'text': return <TextField value={value} onChange={onChange} multiline />;
    case 'bool': return <BoolField value={value} onChange={onChange} />;
    case 'vec3': return <Vec3Field value={value} onChange={onChange} step={f.step ?? 0.1} />;
    case 'color': return <ColorField value={value} onChange={onChange} />;
    case 'enum': return <EnumField value={value} options={f.options} onChange={onChange} allowEmpty />;
    case 'asset': return <EnumField value={value} options={ctx.assets ?? []} onChange={onChange} allowEmpty />;
    case 'archetype': return <EnumField value={value} options={ctx.archetypes ?? []} onChange={onChange} allowEmpty />;
    case 'item': return <EnumField value={value} options={ctx.items ?? []} onChange={onChange} allowEmpty />;
    case 'sound': return <EnumField value={value} options={ctx.sounds ?? []} onChange={onChange} allowEmpty />;
    case 'entity': return <EnumField value={value} options={(ctx.entities ?? []).filter((e) => !f.ref || e.type === f.ref).map((e) => ({ value: e.id, label: `${e.id}${e.name ? ' — ' + e.name : ''}` }))} onChange={onChange} allowEmpty />;
    case 'list': return <ListField value={value} onChange={onChange} />;
    case 'points': return <JsonField value={value} onChange={onChange} rows={4} />;
    default: return <JsonField value={value} onChange={onChange} rows={3} />;
  }
}
