"use client";
import { useCallback, useEffect, useState } from "react";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/relay/${path}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json();
  if (!response.ok) {
    const details = data.errors?.map((e: {field: string; message: string}) => `${e.field}: ${e.message}`).join(" · ");
    const retry = response.headers.get("Retry-After");
    throw new Error(`${data.message ?? "Request failed."}${details ? ` ${details}` : ""}${retry ? ` Retry after ${retry} seconds.` : ""}`);
  }
  return data as T;
}

export function useResource<T>(path: string | null, interval = 15000) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    if (!path) { setState({ loading: false }); return; }
    let live = true;
    let busy = false;
    const controller = new AbortController();
    setState({ loading: true });
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (live) setState({ data, loading: false });
      } catch (error) {
        if (live) setState(previous => ({ data: previous.data, error: error instanceof Error ? error.message : "Connection failed.", loading: false }));
      } finally { busy = false; }
    };
    void load();
    const timer = interval ? setInterval(load, interval) : undefined;
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [path, revision, interval]);
  return { ...state, refresh };
}

export function query(values: Record<string, string | number | undefined>) {
  return new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined && v !== "").map(([k,v]) => [k, String(v)])).toString();
}
