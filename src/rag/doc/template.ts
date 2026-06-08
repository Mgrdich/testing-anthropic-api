export type HandbookTopic = {
  title: string;
  h2Outline: string[];
};

export const TOPICS: ReadonlyArray<HandbookTopic> = [
  {
    title: "Code Review",
    h2Outline: ["Goals", "Process", "Review Checklist", "Common Pitfalls"],
  },
  {
    title: "Incident Response",
    h2Outline: [
      "Severity Levels",
      "Roles and Responsibilities",
      "Communication Channels",
      "Postmortems",
    ],
  },
  {
    title: "On-Call Runbook",
    h2Outline: [
      "Schedule and Handoffs",
      "Alert Triage",
      "Common Alerts",
      "Escalation",
    ],
  },
  {
    title: "Database Migrations",
    h2Outline: [
      "Online Schema Changes",
      "Backfills",
      "Rollback Strategy",
      "Tooling",
    ],
  },
  {
    title: "API Versioning",
    h2Outline: [
      "Versioning Schemes",
      "Backward Compatibility",
      "Deprecation Policy",
      "Client Migrations",
    ],
  },
  {
    title: "Observability",
    h2Outline: ["Logs", "Metrics", "Traces", "Alerting"],
  },
  {
    title: "Testing Strategy",
    h2Outline: [
      "Test Pyramid",
      "Unit Tests",
      "Integration Tests",
      "End-to-End Tests",
    ],
  },
  {
    title: "Deployment Pipeline",
    h2Outline: [
      "Build Stage",
      "Test Stage",
      "Canary and Rollout",
      "Rollback Procedure",
    ],
  },
  {
    title: "Secret Management",
    h2Outline: [
      "Storage Backends",
      "Rotation",
      "Access Control",
      "Auditing",
    ],
  },
  {
    title: "Performance Engineering",
    h2Outline: [
      "Profiling",
      "Caching Strategies",
      "Database Tuning",
      "Load Testing",
    ],
  },
  {
    title: "Security Practices",
    h2Outline: [
      "Threat Modeling",
      "Authentication and Authorization",
      "Dependency Scanning",
      "Incident Disclosure",
    ],
  },
  {
    title: "Documentation Standards",
    h2Outline: [
      "Audience and Tone",
      "Structure",
      "Examples and Diagrams",
      "Maintenance",
    ],
  },
];
