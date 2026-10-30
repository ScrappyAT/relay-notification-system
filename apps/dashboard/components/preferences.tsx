"use client";
import { useState } from "react";
import { LoaderCircle, Mail, MessageSquare, Save, Search } from "lucide-react";
import { api, query, useResource } from "../lib/api";
import type { Channel, Preference } from "../lib/types";
import { Badge, Empty, ErrorState, Loading, Notice, Success, timestamp } from "./ui";

export default function Preferences({ customerId }: { customerId: string }) {
  const [recipient, setRecipient] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [enabled, setEnabled] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const saved = useResource<{preferences: Preference[]; total: number}>(customerId ? `dashboard/preferences?${query({customerId,search,page,limit:10})}` : null);
  const [lookup, setLookup] = useState<{enabled:boolean; isDefault:boolean}>();
  async function loadPreference() {
    setBusy(true);setError(undefined);setSuccess(undefined);setLookup(undefined);
    try {
      const data = await api<{enabled:boolean; isDefault:boolean}>(`recipients/preferences?${query({customerId,recipient,channel})}`);
      setEnabled(data.enabled);setLookup(data);
    } catch(e) {setError(e instanceof Error ? e.message : "Lookup failed.");} finally {setBusy(false);}
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();setBusy(true);setError(undefined);setSuccess(undefined);
    try {
      await api("recipients/preferences", {method:"PUT", body:JSON.stringify({customerId,recipient,channel,enabled})});
      setSuccess(`${channel === "email" ? "Email" : "SMS"} ${enabled ? "enabled" : "disabled"} for ${recipient}.`);setLookup(undefined);saved.refresh();
    } catch(e) {setError(e instanceof Error ? e.message : "Update failed.");} finally {setBusy(false);}
  }
  return <div className="page-stack"><Notice>Preferences belong to the selected tenant and exact recipient address. Unconfigured channels default to enabled. Opt-outs suppress new notifications before queueing.</Notice><div className="preferences-grid"><section className="panel"><div className="panel-heading"><div><h2>Recipient preferences</h2><p>Look up or update a channel preference.</p></div></div><form className="form-body" onSubmit={save}><label className="field-label" htmlFor="preference-recipient">Recipient</label><input id="preference-recipient" required type={channel === "email" ? "email" : "tel"} maxLength={255} placeholder={channel === "email" ? "you@example.com" : "+2348000000000"} value={recipient} onChange={e => {setRecipient(e.target.value);setLookup(undefined);setSuccess(undefined);}}/><label className="field-label" htmlFor="preference-channel">Channel</label><select id="preference-channel" value={channel} onChange={e => {setChannel(e.target.value as Channel);setLookup(undefined);setSuccess(undefined);}}><option value="email">Email</option><option value="sms">SMS</option></select><button className="button secondary lookup-button" type="button" onClick={loadPreference} disabled={!customerId || !recipient || busy}><Search size={15}/>Look up current preference</button>{lookup && <div className="field-hint">{lookup.isDefault ? "No saved preference. Default: enabled." : `Saved preference: ${lookup.enabled ? "enabled" : "disabled"}.`}</div>}<div className="toggle-row"><div><strong>Allow {channel === "email" ? "email" : "SMS"} notifications</strong><p>Disabled recipients are suppressed at ingestion.</p></div><button type="button" role="switch" aria-checked={enabled} aria-label="Allow notifications" className={`toggle ${enabled ? "on" : ""}`} onClick={() => setEnabled(v => !v)}><span/></button></div><ErrorState message={error}/>{success && <Success>{success}</Success>}<div className="form-footer"><span>Changes apply to future requests</span><button className="button primary" disabled={!customerId || busy}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Save size={16}/>}Save preference</button></div></form></section><section className="panel"><div className="panel-heading"><div><h2>Saved preferences</h2><p>{customerId ? `${saved.data?.total ?? "—"} configured preferences` : "Select a tenant to get started"}</p></div></div><div className="filter-bar"><div className="search-field"><Search size={16}/><input aria-label="Search saved preferences" placeholder="Search recipients…" value={search} onChange={e => {setSearch(e.target.value);setPage(1);}}/></div></div><ErrorState message={saved.error} retry={saved.refresh}/>{saved.loading ? <Loading/> : !saved.data?.preferences.length ? <Empty title="No saved preferences" body="Use the form to configure a recipient’s email or SMS preference."/> : <div className="preference-list">{saved.data.preferences.map(p => <button key={p.id} className="preference-row" onClick={() => {setRecipient(p.recipient);setChannel(p.channel);setEnabled(p.enabled);setLookup({enabled:p.enabled,isDefault:false});setSuccess(undefined);}}><span className={`channel-icon ${p.channel}`}>{p.channel === "email" ? <Mail size={17}/> : <MessageSquare size={17}/>}</span><span className="preference-recipient"><strong>{p.recipient}</strong><small>{p.channel.toUpperCase()} · {timestamp(p.updated_at)}</small></span><Badge status={p.enabled ? "enabled" : "disabled"}/></button>)}</div>}<div className="pagination"><button className="button secondary" disabled={page === 1} onClick={() => setPage(v => v - 1)}>Previous</button><span>Page {page}</span><button className="button secondary" disabled={!saved.data || page * 10 >= saved.data.total} onClick={() => setPage(v => v + 1)}>Next</button></div></section></div></div>;
}
