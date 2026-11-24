// Primary navigation items, shared by the header (client) and footer (server).
export const NAV: { href: string; label: string; match?: string }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/treasury", label: "Treasury" },
  { href: "/invoices", label: "Invoices" },
  { href: "/checkout/demo", label: "Checkout", match: "/checkout" },
  { href: "/flows", label: "Flows" },
  { href: "/onboard", label: "Get started" },
];
