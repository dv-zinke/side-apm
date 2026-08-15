// Simulated e-commerce topology. Gateway is the entry; downstream services call
// each other, forming a real trace graph. Latency + error profiles are tuned so
// the console shows a realistic mix of normal / slow / very-slow / error traffic.
//
//   base/jitter (ms) — response time = base + rand*jitter
//   spike           — probability of an extra 1.5–4s stall (very slow)
//   err             — probability of a 500
//   routes          — endpoint names (become transaction names)

const services = [
  { name: "GatewayService",  port: 3101, base: 15, jitter: 25, deps: ["OrderService", "SearchService", "TrackingService"], routes: ["checkout", "search", "track", "products"] },
  { name: "OrderService",    port: 3102, base: 40, jitter: 60, deps: ["InventoryService", "PaymentService"], err: 0.02, routes: ["create", "status"],
    queries: ["SELECT * FROM orders WHERE id = $1", "INSERT INTO orders (user_id, total) VALUES ($1, $2)", "UPDATE orders SET status = $1 WHERE id = $2"] },
  { name: "PaymentService",  port: 3103, base: 80, jitter: 140, deps: [], err: 0.06, spike: 0.05, routes: ["authorize", "capture"],
    queries: ["SELECT * FROM payment_methods WHERE user_id = $1", "UPDATE payments SET status = 'captured' WHERE id = $1"] },
  { name: "InventoryService",port: 3104, base: 30, jitter: 50, deps: [], spike: 0.03, routes: ["reserve", "lookup"],
    queries: ["SELECT stock FROM inventory WHERE sku = $1", "UPDATE inventory SET stock = stock - $1 WHERE sku = $2"] },
  { name: "SearchService",   port: 3105, base: 50, jitter: 80, deps: ["CrawlingService"], routes: ["query"],
    queries: ["SELECT p.* FROM products p JOIN categories c ON p.cat_id = c.id WHERE c.name = $1 ORDER BY p.rank LIMIT 50"] },
  { name: "CrawlingService", port: 3106, base: 220, jitter: 400, deps: [], spike: 0.18, err: 0.03, routes: ["fetch"] },
  { name: "TrackingService", port: 3107, base: 25, jitter: 40, deps: ["MailService"], routes: ["locate"],
    queries: ["SELECT * FROM shipments WHERE tracking_no = $1"] },
  { name: "MailService",     port: 3108, base: 15, jitter: 25, deps: [], routes: ["send"] },
];

const byName = Object.fromEntries(services.map((s) => [s.name, s]));

module.exports = { services, byName };
