/* 1on1トーク  Service Worker
 * - PWA（ホーム画面に追加）用のオフラインキャッシュ
 * - 通知のタップ（notificationclick）でアプリを開く／前面に出す
 * - 将来 Web Push（サーバー送信）を足しても動くよう push も受ける
 *
 * このファイルは gachapon リポジトリのルートにあり scope は /gachapon/ だが、
 * 触るのは talk.html とトーク用アイコンだけ。index.html / oripa.html / call.html 等は
 * 一切キャッシュせず、ネットワークへそのまま流す（他アプリを壊さないため）。
 */
"use strict";

var CACHE = "talk-pwa-v1";
var PRECACHE = [
  "talk.html",
  "manifest.webmanifest",
  "talk-icon-192.png",
  "talk-icon-512.png",
  "talk-icon-maskable-512.png"
];

var SCOPE_URL = new URL(self.registration.scope);
var TALK_URL = new URL("talk.html", SCOPE_URL).href;

function abs(path) { return new URL(path, SCOPE_URL).href; }

function isOwned(url) {
  if (url.origin !== SCOPE_URL.origin) return false;
  var clean = url.href.split("#")[0].split("?")[0];
  if (clean === TALK_URL) return true;
  if (url.pathname === new URL("manifest.webmanifest", SCOPE_URL).pathname) return true;
  if (/\/talk-icon-[A-Za-z0-9._-]*\.png$/.test(url.pathname)) return true;
  return false;
}

/* ---------------- install / activate ---------------- */

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        // 1つ失敗しても他は入れる
        return Promise.all(PRECACHE.map(function (p) {
          return cache.add(new Request(abs(p), { cache: "reload" })).catch(function () {});
        }));
      })
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          // 自分が作ったキャッシュだけ片付ける
          if (k !== CACHE && k.indexOf("talk-pwa-") === 0) return caches.delete(k);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ---------------- fetch ---------------- */

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!isOwned(url)) return; // トーク以外はブラウザに任せる

  var isNav = req.mode === "navigate" || req.destination === "document";
  var key = new Request(url.href.split("#")[0].split("?")[0], { method: "GET" });

  if (isNav) {
    // 画面本体はネットワーク優先（更新がすぐ届く）→ オフライン時だけキャッシュ
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(key, copy); }).catch(function () {});
          }
          return res;
        })
        .catch(function () {
          return caches.match(TALK_URL).then(function (hit) {
            return hit || new Response(
              "<!DOCTYPE html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
              "<body style='font-family:-apple-system,sans-serif;background:#0b0a14;color:#f6f4ff;padding:40px 22px;text-align:center'>" +
              "<h2>オフラインです</h2><p>電波の良い場所でもう一度開いてください。</p></body>",
              { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
          });
        })
    );
    return;
  }

  // アイコン・manifest はキャッシュ優先＋裏で更新
  event.respondWith(
    caches.match(key).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(key, res); }).catch(function () {});
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(key, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});

/* ---------------- 通知 ---------------- */

function notifOptions(data) {
  var d = data || {};
  return {
    body: d.body || "新しいメッセージ",
    icon: abs(d.icon || "talk-icon-192.png"),
    badge: abs("talk-icon-192.png"),
    tag: d.tag || "talk",
    renotify: !!d.renotify,
    silent: !!d.silent,
    vibrate: d.vibrate || [80, 40, 80],
    data: { url: d.url || TALK_URL, kind: d.kind || "msg" }
  };
}

function show(title, data) {
  return self.registration.showNotification(title || "1on1トーク", notifOptions(data));
}

/* ページからの依頼（Service Worker 経由で通知を出す） */
self.addEventListener("message", function (event) {
  var d = event.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "notify") {
    event.waitUntil(show(d.title, d).catch(function () {}));
  } else if (d.type === "skip-waiting") {
    self.skipWaiting();
  }
});

/* 将来の Web Push（Cloudflare Workers 等から送る場合） */
self.addEventListener("push", function (event) {
  var d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(show(d.title || "1on1トーク", d).catch(function () {}));
});

/* 通知タップ → アプリを前面に出す（なければ開く） */
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var target = data.url || TALK_URL;

  event.waitUntil((function () {
    return self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var samePath = false;
          try {
            samePath = new URL(c.url).pathname === new URL(target).pathname;
          } catch (e) { samePath = false; }
          if (samePath && "focus" in c) {
            return c.focus().then(function () {
              if (data.kind && "postMessage" in c) {
                try { c.postMessage({ type: "notification-click", kind: data.kind, tag: data.tag }); } catch (e) {}
              }
            });
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return null;
      });
  })());
});

self.addEventListener("notificationclose", function () { /* 何もしない */ });
