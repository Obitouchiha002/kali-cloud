// ===================================================================
//  Plan tiers + what each unlocks. Enforced server-side at spawn time
//  (never trust the client), so a user can't unlock paid features by
//  editing the page.
// ===================================================================
export const PLANS = {
  free: {
    id: "free", name: "Student", price: "Free",
    toolset: "core",                 // core Kali tools
    persistent: false,               // no saved storage
    egress: false,                   // sealed: no internet
    wifi: false,                     // no hardware wireless lab
    maxSessionMs: 45 * 60 * 1000,    // 45 min
    memory: "2g", cpus: "2", pids: 400,
    security: "standard",            // baseline hardening
    profiles: ["low", "medium", "high"],
  },
  pro: {
    id: "pro", name: "Pro", price: "Paid",
    toolset: "full",                 // full advanced toolset
    persistent: true,                // saved /home
    egress: "controlled",           // audited egress (for CTFs)
    wifi: false,                     // wifi = hardware add-on
    maxSessionMs: 4 * 60 * 60 * 1000, // 4 h
    memory: "4g", cpus: "4", pids: 800,
    security: "hardened",            // + extra layer
    profiles: ["low", "medium", "high"],
  },
  admin: {
    id: "admin", name: "Admin", price: "—",
    toolset: "full",
    persistent: true,
    egress: "controlled",
    wifi: true,                      // full access incl. wireless structure
    maxSessionMs: 12 * 60 * 60 * 1000,
    memory: "6g", cpus: "6", pids: 1200,
    security: "hardened",
    profiles: ["low", "medium", "high"],
  },
};

export function planFor(id) {
  return PLANS[id] || PLANS.free;
}
