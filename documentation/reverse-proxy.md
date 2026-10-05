# Reverse proxy and realtime SSE

Cartethyia's Console uses Server-Sent Events (SSE) for live Console Logs, Usage
in-flight state, provider topology, and shared dashboard statistics. These streams
must be forwarded without response compression or buffering.

## Why this matters

SSE writes small frames continuously. Applying gzip or another response compressor
can buffer those frames until it has enough data to flush. The API request itself
still works, but dashboard events appear late — often only when a chat request has
already completed.

Keep these routes uncompressed:

- `/console/api/logs/stream`
- `/console/api/live/in-flight/stream`
- `/console/api/live/pools/stream`
- `/console/api/share/*/stats/stream`

## Caddy example

The matcher scopes compression to all non-SSE requests, so normal dashboard/API
responses can still use gzip while realtime streams are immediate.

```caddy
router.example.com {
    @notConsoleSse not path \
        /console/api/logs/stream \
        /console/api/live/in-flight/stream \
        /console/api/live/pools/stream \
        /console/api/share/*/stats/stream

    encode @notConsoleSse gzip
    reverse_proxy 127.0.0.1:12800
}
```

Validate and reload after changing the configuration:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## Verification

The SSE endpoint requires Console authentication, but its response headers must
not include `content-encoding: gzip`. A functional end-to-end check opens the SSE
stream before sending a chat request:

1. Receive `request_dispatch` shortly after sending the request.
2. Confirm it includes `providerId` and the routed model.
3. Receive `request_complete` or `request_error` when the request terminates.

`request_dispatch` is emitted when Cartethyia has bound a provider, before the
upstream request begins. It drives the Usage topology beam for the exact lifetime
of a request.
