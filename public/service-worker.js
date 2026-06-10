// TruckX Auto Dialer - Service Worker
// Handles background calls, notifications, and keeping portal alive

console.log('[Service Worker] TruckX Auto Dialer loaded');

// Handle incoming call notifications
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push notification received:', event.data);
  
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch (e) {
    console.error('[Service Worker] Failed to parse push data:', e);
    data = { title: 'Incoming Call', body: event.data?.text() };
  }

  const { title = 'TruckX Call', body = 'New incoming call', callSid, fromNumber } = data;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/truckx-logo.svg',
      badge: '/truckx-logo.svg',
      tag: `call-${callSid || Date.now()}`,
      requireInteraction: true,
      actions: [
        { action: 'accept', title: 'Accept Call' },
        { action: 'reject', title: 'Reject' }
      ],
      data: { callSid, fromNumber }
    })
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification clicked:', event.action);
  
  event.notification.close();

  const { callSid, fromNumber } = event.notification.data;
  const action = event.action;

  // Tell all tabs about the action
  event.waitUntil(
    clients.matchAll({ includeUncontrolled: true, type: 'window' })
      .then((allClients) => {
        console.log('[Service Worker] Found', allClients.length, 'clients');
        
        allClients.forEach((client) => {
          client.postMessage({
            type: 'NOTIFICATION_ACTION',
            action: action,
            callSid: callSid,
            fromNumber: fromNumber
          });
        });

        // If no clients, open the portal
        if (allClients.length === 0) {
          return clients.openWindow('/agent/portal');
        }
      })
  );
});

// Periodic sync to keep agent online
self.addEventListener('sync', (event) => {
  if (event.tag === 'keep-alive') {
    event.waitUntil(
      fetch('/api/agent/heartbeat', { method: 'POST' })
        .then(() => console.log('[Service Worker] Heartbeat sent'))
        .catch((err) => console.error('[Service Worker] Heartbeat failed:', err))
    );
  }
});

// Handle service worker updates
self.addEventListener('controllerchange', () => {
  console.log('[Service Worker] Controller changed');
});

self.addEventListener('install', () => {
  console.log('[Service Worker] Installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(clients.claim());
});

console.log('[Service Worker] Ready to handle incoming calls');