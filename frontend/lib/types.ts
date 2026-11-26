// Shared API types mirroring the FastAPI schemas.

export type Role = "super_admin" | "city_operator" | "field_engineer" | "city_analyst";

export interface RoleInfo {
  key: string;
  name: string;
  description: string;
}

export interface User {
  id: number;
  email: string;
  full_name: string;
  job_title: string | null;
  phone: string | null;
  avatar_color: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: RoleInfo[];
  permissions?: string[];
}

export interface Meta {
  total: number;
  page: number;
  page_size: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface ListResponse<T> {
  success: true;
  data: T[];
  meta: Meta;
  unread_count?: number;
}

export interface ItemResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type AssetStatus = "operational" | "degraded" | "offline" | "maintenance" | "archived";

export interface Zone {
  id: number;
  code: string;
  name: string;
  district: string;
  population: number;
  center_x: number;
  center_y: number;
  assets?: number;
}

export interface Asset {
  id: number;
  code: string;
  name: string;
  category: string;
  category_label: string;
  status: AssetStatus;
  criticality: number;
  capacity: number;
  capacity_unit: string;
  load_percent: number;
  latitude: number;
  longitude: number;
  map_x: number;
  map_y: number;
  zone_id: number | null;
  zone: Zone | null;
  built_year: number | null;
  last_inspection_at: string | null;
  notes: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  inbound_dependencies?: number;
  outbound_dependencies?: number;
}

export interface DependencyRow {
  id: number;
  source_asset_id: number;
  target_asset_id: number;
  dependency_type: string;
  impact_weight: number;
  redundancy: number;
  description: string | null;
  created_at: string;
  source_code: string;
  source_name: string;
  target_code: string;
  target_name: string;
}

export interface AssetDetail extends Asset {
  inbound: DependencyRow[];
  outbound: DependencyRow[];
  history: {
    id: number;
    previous_status: string | null;
    new_status: string;
    reason: string | null;
    changed_at: string;
    changed_by_id: number | null;
  }[];
  active_incidents?: { id: number; code: string; title: string; severity: string; status: string }[];
}

export interface TwinNode {
  id: number;
  code: string;
  name: string;
  category: string;
  status: AssetStatus;
  criticality: number;
  map_x: number;
  map_y: number;
  zone: string | null;
  capacity: number;
  load_percent: number;
  active_incidents: number;
}

export interface TwinEdge {
  id: number;
  source: number;
  target: number;
  dependency_type: string;
  impact_weight: number;
  redundancy: number;
}

export interface TwinGraph {
  nodes: TwinNode[];
  edges: TwinEdge[];
  zones: Zone[];
  generated_at: string;
  stats: { nodes: number; edges: number; by_status: Record<string, number> };
}

export interface Impact {
  asset_id: number;
  code: string;
  name: string;
  category: string;
  impact_level: "failed" | "degraded" | "affected";
  depth: number;
  impact_score: number;
  capacity_loss_percent: number;
  affected_population: number;
  cause_asset_id: number | null;
  explanation: string;
}

export interface SimulationSummary {
  assets_total: number;
  assets_impacted: number;
  assets_failed: number;
  assets_degraded: number;
  assets_affected: number;
  max_depth_reached: number;
  affected_population: number;
  critical_services_down: string[];
  severity_index: number;
  cascade_category_breakdown: Record<string, number>;
  failure_mode: string;
  cascade_threshold: number;
}

export interface SimulationRun {
  id: number;
  code: string;
  name: string;
  status: string;
  failure_mode: string;
  cascade_threshold: number;
  max_depth: number;
  random_seed: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by_id: number | null;
  incident_id: number | null;
  summary: SimulationSummary;
  initial_failure_ids: number[];
}

export interface SimulationRunDetail extends SimulationRun {
  impacts: Impact[];
  timeline: {
    depth: number;
    asset_id: number;
    code: string;
    level: string;
    reason: string;
    affected_population: number;
  }[];
  graph_warnings: string[];
  assumptions: string[];
  snapshot_hash: string;
  initial_failure_ids_json?: string;
  summary_json?: string;
}

export interface PlanAssignment {
  id: number;
  asset_id: number;
  resource_id: number;
  quantity: number;
  priority_weight: number;
  contribution: number;
  served: boolean;
  rationale: string;
  repair_task_id: number | null;
  asset_code?: string;
  asset_name?: string;
  asset_category?: string;
  resource_code?: string;
  resource_name?: string;
}

export interface OptimizationPlan {
  id: number;
  code: string;
  status: string;
  solution_status: string;
  objective_value: number;
  covered_demand: number;
  total_demand: number;
  coverage_percent: number;
  solver_wall_ms: number;
  infeasibility_reason: string | null;
  approved_at: string | null;
  approved_by_id: number | null;
  created_at: string;
  assignments: PlanAssignment[];
  explanation?: {
    steps: string[];
    unserved: { asset_id: number; asset_code: string; asset_name: string; priority: number; need: number; reason: string }[];
    resource_usage: Record<string, { code: string; name: string; available: number; allocated: number; utilisation_percent: number }>;
    debug?: Record<string, unknown>;
    relaxation?: string;
  };
  request?: { id: number; code: string; title: string; objective: string; status: string };
  workflow_id?: number | null;
}

export interface Incident {
  id: number;
  code: string;
  title: string;
  description: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  primary_asset_id: number;
  reported_by_id: number | null;
  assigned_operator_id: number | null;
  affected_population: number;
  simulation_run_id: number | null;
  optimization_plan_id: number | null;
  workflow_id: number | null;
  reported_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  primary_asset_code?: string | null;
  primary_asset_name?: string | null;
  task_count: number;
  open_task_count: number;
  affected_assets?: { id: number; asset_id: number; impact_level: string; impact_score: number }[];
  events?: {
    id: number;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    message: string;
    actor_id: number | null;
    created_at: string;
  }[];
  allowed_transitions?: string[];
}

export interface Reservation {
  id: number;
  resource_id: number;
  repair_task_id: number | null;
  plan_id: number | null;
  workflow_id: number | null;
  quantity: number;
  status: string;
  reserved_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface RepairTask {
  id: number;
  code: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  incident_id: number | null;
  asset_id: number;
  assignee_id: number | null;
  estimated_hours: number;
  actual_hours: number | null;
  due_at: string | null;
  assigned_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_at: string | null;
  completion_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  asset_code?: string | null;
  asset_name?: string | null;
  incident_code?: string | null;
  assignee_name?: string | null;
  reservations: Reservation[];
  history?: {
    id: number;
    from_status: string | null;
    to_status: string;
    note: string | null;
    actor_id: number | null;
    changed_at: string;
  }[];
  allowed_transitions?: string[];
}

export interface Resource {
  id: number;
  code: string;
  name: string;
  category: string;
  capacity: number;
  capacity_unit: string;
  status: string;
  home_zone_id: number | null;
  hourly_cost: number;
  mobilisation_minutes: number;
  notes: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  reserved_quantity: number;
  available_quantity: number;
  active_reservations: number;
  reservations?: Reservation[];
}

export interface WorkflowStep {
  key: string;
  label: string;
  status: "done" | "failed" | "current" | "pending";
}

export interface WorkflowEvent {
  id: number;
  step: string;
  attempt: number;
  outcome: string;
  message: string;
  actor_id: number | null;
  created_at: string;
}

export interface Workflow {
  id: number;
  code: string;
  workflow_type: string;
  title: string;
  status: string;
  current_step: string;
  incident_id: number | null;
  simulation_run_id: number | null;
  plan_id: number | null;
  failure_step: string | null;
  failure_reason: string | null;
  retry_count: number;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  completed_steps: string[];
  events?: WorkflowEvent[];
  next_actions?: string[];
  steps?: WorkflowStep[];
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  category: string;
  severity: string;
  link: string | null;
  entity_type: string | null;
  entity_id: number | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  actor_id: number | null;
  actor_email: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  message: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface Overview {
  window_days: number;
  assets_total: number;
  asset_status_counts: Record<string, number>;
  health_index: number;
  avg_load_percent: number;
  active_incidents: number;
  incident_status_counts: Record<string, number>;
  incidents_reported: number;
  incidents_resolved: number;
  open_tasks: number;
  completed_tasks: number;
  resource_capacity: number;
  resource_reserved: number;
  resource_utilisation_percent: number;
  mean_time_to_repair_hours: number;
  population_at_risk: number;
  dependencies_total: number;
  simulations_total: number;
  plans_total: number;
  generated_at: string;
}

export interface DashboardBundle {
  overview: Overview;
  generated_at: string;
  category_breakdown: {
    category: string;
    label: string;
    total: number;
    operational: number;
    degraded: number;
    offline: number;
    maintenance: number;
    availability_percent: number;
  }[];
  scope: Record<string, boolean>;
  incident_trends?: { date: string; reported: number; resolved: number; critical: number }[];
  severity_breakdown?: { severity: string; count: number }[];
  resource_utilisation?: {
    category: string;
    label: string;
    count: number;
    capacity: number;
    reserved: number;
    available: number;
    utilisation_percent: number;
  }[];
  simulation_comparison?: {
    id: number;
    code: string;
    name: string;
    started_at: string;
    severity_index: number;
    assets_failed: number;
    affected_population: number;
    max_depth_reached: number;
    status: string;
  }[];
  failure_impact?: { code: string; name: string; summary: SimulationSummary; started_at: string }[];
  recovery_performance?: {
    verified_tasks: number;
    avg_hours_to_verify: number;
    by_priority: { priority: number; tasks: number; avg_hours: number }[];
    on_time_percent: number;
  };
  active_incident_list: {
    id: number;
    code: string;
    title: string;
    severity: string;
    status: string;
    reported_at: string;
    affected_population: number;
  }[];
  latest_simulation: {
    id: number;
    code: string;
    name: string;
    status: string;
    started_at: string;
    summary: SimulationSummary;
  } | null;
  pending_plan_approvals: number;
  task_board: {
    id: number;
    code: string;
    title: string;
    status: string;
    priority: number;
    due_at: string | null;
    assignee_id: number | null;
  }[];
  resource_spotlight: {
    id: number;
    code: string;
    name: string;
    capacity: number;
    capacity_unit: string;
    status: string;
  }[];
  my_open_tasks: number;
  unread_notifications: number;
}

/* ------------------------------------------------------------ risk heatmap */

/** One band of the resilience heatmap legend, as the backend describes it. */
export interface HeatmapLegendEntry {
  band: string;
  label: string;
  threshold: number;
  description: string;
  color_token: string;
}

/** A zone's exposure, scored from the latest simulated run. */
export interface HeatmapZone {
  zone_id: number;
  code: string;
  name: string;
  district: string;
  population: number;
  center_x: number;
  center_y: number;
  risk_score: number;
  risk_band: string;
  asset_count: number;
  assets_failed: number;
  assets_degraded: number;
  population_at_risk: number;
  drivers: string[];
  top_assets: {
    asset_id: number;
    code: string;
    name: string;
    category: string;
    status: string;
    map_x: number;
    map_y: number;
    criticality: number;
    criticality_index: number;
    stored_impact: string;
    risk_score: number;
  }[];
}

/** An asset's exposure across the whole city, for the per-building tint. */
export interface HeatmapAsset {
  asset_id: number;
  code: string;
  name: string;
  category: string;
  map_x: number;
  map_y: number;
  risk_score: number;
  risk_band: string;
  stored_impact: string;
  criticality_index: number;
}

export interface Heatmap {
  source: "latest" | "run" | "baseline";
  zones: HeatmapZone[];
  assets: HeatmapAsset[];
  legend: HeatmapLegendEntry[];
  assumptions: Record<string, string>;
  runs: { run_id: number | null; code: string | null; created_at: string | null };
  model: { impact_weight: number; criticality_weight: number; impact_levels: Record<string, number> };
  totals: { zones: number; population_at_risk: number; assets_failed: number; assets_degraded: number };
  generated_at: string;
}

/* ------------------------------------------------------------- time travel */

/** One recorded change in the twin's history, as `/resilience/timetravel` reports it. */
export interface TimelineStep {
  index: number;
  at: string;
  kind: "status" | "incident" | "response" | "simulation" | "design" | "dispatch" | string;
  summary: string;
  detail: string;
  from?: string | null;
  to?: string | null;
  asset_id?: number | null;
  asset_code?: string | null;
  was?: string | null;
  now?: string | null;
}

export interface Timeline {
  window: { since: string; until: string };
  steps: TimelineStep[];
  step_count: number;
  total_changes: number;
  truncated: boolean;
  snapshot_at_end: Record<string, unknown>;
  sources: Record<string, number>;
  notes: string[];
}

/* ------------------------------------------------------------- criticality */

export interface CriticalityRow {
  asset_id: number;
  code: string;
  name: string;
  category: string;
  status: string;
  criticality: number;
  zone: { id: number; code: string; name: string } | null;
  map_x: number;
  map_y: number;
  criticality_index: number;
  components: { reach: number; blast: number; population: number; single_point: number };
  dependants_direct: number;
  reach_score: number;
  reach_all: number;
  single_point_dependants: number;
  consequence: {
    assets_failed: number;
    assets_degraded: number;
    assets_affected: number;
    population_affected: number;
    max_depth_reached: number;
    critical_services_lost: string[];
    critical_services_lost_count: number;
    snapshot_hash: string;
    explanation: string;
  };
}

export interface CriticalityIndex {
  generated_at: string;
  model: { weights: Record<string, number>; assumptions: string[] };
  /**
   * Fleet-level counts, exactly as `/resilience/criticality` returns them.
   * The mean/peak of the ranking is derived from `ranking` (see
   * `lib/criticality.ts`) -- earlier versions of this type claimed fields the
   * API never sent, and every consumer that called `.toFixed` on them crashed
   * as soon as the data landed.
   */
  fleet: { assets: number; total_dependencies: number; critical_assets: number };
  ranking: CriticalityRow[];
}

/* -------------------------------------------------------------- investment */

export interface InvestmentOption {
  asset_id: number;
  asset_code: string;
  asset_name: string;
  category: string;
  zone_id: number | null;
  intervention: string;
  mechanism: string;
  annual_cost: number;
  benefit: {
    population_protected: number;
    assets_saved: number;
    critical_services_protected: string[];
    resilience_score: number;
  };
  changes_anything: boolean;
}

export interface InvestmentPlan {
  baseline: {
    trigger_codes: string[];
    assets_failed: number;
    population_at_risk: number;
    critical_services_lost: string[];
  };
  objective?: Record<string, number>;
  options: InvestmentOption[];
  interventions_considered?: number;
  assets_considered?: number;
  method: {
    weighting?: Record<string, number>;
    cost_basis?: Record<string, string>;
    costs_are?: string;
    assumptions?: string[];
  };
  assumptions: string[];
  notes: string[];
}
