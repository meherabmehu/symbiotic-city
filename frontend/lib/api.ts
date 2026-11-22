"use client";

/**
 * Typed API client.
 *
 * The browser never talks to the FastAPI host directly: every call goes to the
 * same origin under /api and Next.js proxies it (see next.config.mjs). That
 * keeps cookies first-party and avoids CORS in preview environments.
 *
 * State-changing calls automatically mirror the readable CSRF cookie into the
 * X-CSRF-Token header expected by the backend.
 */

import type { ApiFailure, ListResponse, ItemResponse } from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Field level messages, if the error came from request validation. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const entry of this.details as { field?: string; message?: string }[]) {
      if (entry.field) out[entry.field] = entry.message ?? "Invalid value";
    }
    return out;
  }
}

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Skip JSON parsing (used for CSV downloads). */
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!SAFE.has(method)) {
    const csrf = readCookie("symbiotic_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ApiError(
      "The network request failed. Check your connection and try again.",
      "network_error",
      0,
    );
  }

  if (options.raw) {
    if (!response.ok) {
      let message = "The download failed.";
      try {
        const failure = (await response.json()) as ApiFailure;
        message = failure.error?.message ?? message;
      } catch {
        /* keep the default message */
      }
      throw new ApiError(message, "download_failed", response.status);
    }
    return (await response.text()) as unknown as T;
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const failure = payload as ApiFailure | null;
    throw new ApiError(
      failure?.error?.message ?? `Request failed with status ${response.status}.`,
      failure?.error?.code ?? "request_failed",
      response.status,
      failure?.error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<ItemResponse<T>>(path, options).then((r) => r.data),
  list: <T>(path: string, options?: RequestOptions) =>
    request<ListResponse<T>>(path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<ItemResponse<T>>(path, { ...options, method: "POST", body }).then((r) => r.data),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<ItemResponse<T>>(path, { ...options, method: "PATCH", body }).then((r) => r.data),
  del: <T>(path: string, options?: RequestOptions) =>
    request<ItemResponse<T>>(path, { ...options, method: "DELETE" }).then((r) => r.data),
  download: (path: string) => request<string>(path, { raw: true }),
  raw: request,
};

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
