importScripts("/sw-core.js");

self.addEventListener("install", onInstall);
self.addEventListener("activate", onActivate);
self.addEventListener("fetch", onFetch);
self.addEventListener("message", onMessage);
self.addEventListener("sync", onSync);
self.addEventListener("backgroundfetchsuccess", onBackgroundFetchSuccess);
self.addEventListener("backgroundfetchfail", onBackgroundFetchFail);
self.addEventListener("backgroundfetchabort", onBackgroundFetchAbort);
