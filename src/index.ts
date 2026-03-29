import {
  Compression,
  EtagMismatch,
  PMTiles,
  RangeResponse,
  ResolvedValueCache,
  Source,
  TileType,
  tileTypeExt,
} from "pmtiles";

interface Env {
  ALLOWED_ORIGINS?: string;
  BUCKET: R2Bucket;
  CACHE_CONTROL?: string;
  PMTILES_PATH?: string;
  PUBLIC_HOSTNAME?: string;
}

class KeyNotFoundError extends Error {}

async function nativeDecompress(
  buf: ArrayBuffer,
  compression: Compression,
): Promise<ArrayBuffer> {
  if (
    compression === Compression.None ||
    compression === Compression.Unknown
  ) {
    return buf;
  }
  if (compression === Compression.Gzip) {
    const stream = new Response(buf).body;
    const result = stream?.pipeThrough(new DecompressionStream("gzip"));
    return new Response(result).arrayBuffer();
  }
  throw new Error("Compression method not supported");
}

const CACHE = new ResolvedValueCache(25, undefined, nativeDecompress);

function pmtilesPath(name: string, setting?: string): string {
  if (setting) {
    return setting.replaceAll("{name}", name);
  }
  return `${name}.pmtiles`;
}

interface TileParsed {
  ok: boolean;
  name: string;
  tile?: [number, number, number];
  ext: string;
  rangeRequest?: boolean;
}

function tilePath(
  path: string,
  hasRangeHeader: boolean,
): TileParsed {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0]!.endsWith(".json")) {
    return { ok: true, name: parts[0]!.replace(".json", ""), ext: "json" };
  }
  // Bare path like /basemap with Range header = PMTiles range request pass-through
  if (parts.length === 1 && !parts[0]!.includes(".") && hasRangeHeader) {
    return { ok: true, name: parts[0]!, ext: "", rangeRequest: true };
  }
  if (parts.length === 4) {
    const name = parts[0]!;
    const z = Number.parseInt(parts[1]!, 10);
    const x = Number.parseInt(parts[2]!, 10);
    const lastPart = parts[3]!;
    const dotIdx = lastPart.lastIndexOf(".");
    if (dotIdx < 0) return { ok: false, name: "", ext: "" };
    const y = Number.parseInt(lastPart.substring(0, dotIdx), 10);
    const ext = lastPart.substring(dotIdx + 1);
    if (Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y)) {
      return { ok: false, name: "", ext: "" };
    }
    return { ok: true, name, tile: [z, x, y], ext };
  }
  return { ok: false, name: "", ext: "" };
}

class R2Source implements Source {
  env: Env;
  archiveName: string;

  constructor(env: Env, archiveName: string) {
    this.env = env;
    this.archiveName = archiveName;
  }

  getKey() {
    return this.archiveName;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const resp = await this.env.BUCKET.get(
      pmtilesPath(this.archiveName, this.env.PMTILES_PATH),
      {
        range: { offset, length },
        onlyIf: { etagMatches: etag },
      },
    );
    if (!resp) {
      throw new KeyNotFoundError("Archive not found");
    }

    const o = resp as R2ObjectBody;
    if (!o.body) {
      throw new EtagMismatch();
    }

    const a = await o.arrayBuffer();
    return {
      data: a,
      etag: o.etag,
      cacheControl: o.httpMetadata?.cacheControl,
      expires: o.httpMetadata?.cacheExpiry?.toISOString(),
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method.toUpperCase() === "POST") {
      return new Response(undefined, { status: 405 });
    }

    const url = new URL(request.url);
    const hasRange = request.headers.has("Range");
    const { ok, name, tile, ext, rangeRequest } = tilePath(url.pathname, hasRange);
    const cache = caches.default;

    if (!ok) {
      return new Response("Invalid URL", { status: 404 });
    }

    let allowedOrigin = "";
    if (env.ALLOWED_ORIGINS) {
      for (const o of env.ALLOWED_ORIGINS.split(",")) {
        if (o === request.headers.get("Origin") || o === "*") {
          allowedOrigin = o;
        }
      }
    }

    const corsHeaders = (headers: Headers): Headers => {
      if (allowedOrigin) {
        headers.set("Access-Control-Allow-Origin", allowedOrigin);
      }
      headers.set("Vary", "Origin");
      return headers;
    };

    // Handle CORS preflight
    if (request.method.toUpperCase() === "OPTIONS") {
      const headers = new Headers();
      corsHeaders(headers);
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Range");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(undefined, { status: 204, headers });
    }

    // PMTiles range request pass-through: browser pmtiles library sends
    // Range requests to /basemap which we proxy to the .pmtiles file in R2.
    if (rangeRequest) {
      const key = pmtilesPath(name, env.PMTILES_PATH);
      const rangeHeader = request.headers.get("Range");

      const obj = rangeHeader
        ? await env.BUCKET.get(key, { range: request.headers })
        : await env.BUCKET.get(key);

      if (!obj) {
        const headers = corsHeaders(new Headers());
        return new Response("Archive not found", { status: 404, headers });
      }

      const respHeaders = corsHeaders(new Headers());
      respHeaders.set("Content-Type", "application/octet-stream");
      respHeaders.set("Cache-Control", env.CACHE_CONTROL || "public, max-age=86400");
      respHeaders.set("Accept-Ranges", "bytes");

      if (obj.range) {
        const r = obj.range as { offset: number; length: number };
        respHeaders.set(
          "Content-Range",
          `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`,
        );
        respHeaders.set("Content-Length", String(r.length));
        return new Response((obj as R2ObjectBody).body, {
          status: 206,
          headers: respHeaders,
        });
      }

      respHeaders.set("Content-Length", String(obj.size));
      return new Response((obj as R2ObjectBody).body, {
        status: 200,
        headers: respHeaders,
      });
    }

    // Standard tile/TileJSON serving with CF Cache API
    const cached = await cache.match(request.url);
    if (cached) {
      const respHeaders = corsHeaders(new Headers(cached.headers));
      return new Response(cached.body, {
        headers: respHeaders,
        status: cached.status,
      });
    }

    const cacheableResponse = (
      body: ArrayBuffer | string | undefined,
      cacheableHeaders: Headers,
      status: number,
    ) => {
      cacheableHeaders.set(
        "Cache-Control",
        env.CACHE_CONTROL || "public, max-age=86400",
      );
      const cacheable = new Response(body, {
        headers: cacheableHeaders,
        status,
      });
      ctx.waitUntil(cache.put(request.url, cacheable));

      const respHeaders = corsHeaders(new Headers(cacheableHeaders));
      return new Response(body, { headers: respHeaders, status });
    };

    const cacheableHeaders = new Headers();
    const source = new R2Source(env, name);
    const p = new PMTiles(source, CACHE, nativeDecompress);

    try {
      const pHeader = await p.getHeader();

      if (!tile) {
        cacheableHeaders.set("Content-Type", "application/json");
        const t = await p.getTileJson(
          `https://${env.PUBLIC_HOSTNAME || url.hostname}/${name}`,
        );
        return cacheableResponse(JSON.stringify(t), cacheableHeaders, 200);
      }

      if (tile[0] < pHeader.minZoom || tile[0] > pHeader.maxZoom) {
        return cacheableResponse(undefined, cacheableHeaders, 404);
      }

      const extToType: Record<string, TileType> = {
        mvt: TileType.Mvt,
        pbf: TileType.Mvt,
        png: TileType.Png,
        jpg: TileType.Jpeg,
        webp: TileType.Webp,
        avif: TileType.Avif,
      };

      const expectedType = extToType[ext];
      if (
        pHeader.tileType !== expectedType &&
        tileTypeExt(pHeader.tileType) !== ""
      ) {
        return cacheableResponse(
          `Bad request: requested .${ext} but archive has type ${tileTypeExt(pHeader.tileType)}`,
          cacheableHeaders,
          400,
        );
      }

      const tiledata = await p.getZxy(tile[0], tile[1], tile[2]);

      switch (pHeader.tileType) {
        case TileType.Mvt:
          cacheableHeaders.set("Content-Type", "application/x-protobuf");
          break;
        case TileType.Png:
          cacheableHeaders.set("Content-Type", "image/png");
          break;
        case TileType.Jpeg:
          cacheableHeaders.set("Content-Type", "image/jpeg");
          break;
        case TileType.Webp:
          cacheableHeaders.set("Content-Type", "image/webp");
          break;
      }

      if (tiledata) {
        return cacheableResponse(tiledata.data, cacheableHeaders, 200);
      }
      return cacheableResponse(undefined, cacheableHeaders, 204);
    } catch (e) {
      if (e instanceof KeyNotFoundError) {
        return cacheableResponse("Archive not found", cacheableHeaders, 404);
      }
      throw e;
    }
  },
};
