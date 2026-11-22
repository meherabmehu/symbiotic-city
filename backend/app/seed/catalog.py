"""Static, deterministic definition of the fictional city Aurora Vale.

Everything here is synthetic demonstration data. No real city, operator or
member of the public is described. Geography is invented; coordinates are
plausible for a river city but do not correspond to any real address.
"""
from __future__ import annotations

CITY = {
    "name": "Aurora Vale",
    "tagline": "Synthetic digital twin city — demonstration data",
    "population": 148_000,
    "grid": "Normalised 0-100 twin coordinates",
}

ZONES = [
    {
        "code": "Z-CEN",
        "name": "Central District",
        "district": "Aurora Vale",
        "population": 38_500,
        "center_x": 50,
        "center_y": 48,
    },
    {
        "code": "Z-NOR",
        "name": "Northgate",
        "district": "Aurora Vale",
        "population": 26_000,
        "center_x": 46,
        "center_y": 18,
    },
    {
        "code": "Z-RIV",
        "name": "Riverside",
        "district": "Aurora Vale",
        "population": 31_200,
        "center_x": 22,
        "center_y": 62,
    },
    {
        "code": "Z-EAS",
        "name": "Eastfield",
        "district": "Aurora Vale",
        "population": 29_800,
        "center_x": 78,
        "center_y": 40,
    },
    {
        "code": "Z-SOU",
        "name": "Southbank",
        "district": "Aurora Vale",
        "population": 22_500,
        "center_x": 55,
        "center_y": 82,
    },
]

# code, name, category, zone, criticality, capacity, unit, load, lat, lon, map_x, map_y, year
ASSETS = [
    ("PS-01", "Vale Central Power Station", "power_station", "Z-CEN", 1, 420, "MW", 62, 23.8103, 90.4125, 48, 44, 1998),
    ("PS-02", "Northgate Gas Turbine", "power_station", "Z-NOR", 2, 210, "MW", 55, 23.8241, 90.4051, 45, 14, 2009),
    ("SS-01", "Central 132kV Substation", "substation", "Z-CEN", 2, 260, "MVA", 68, 23.8095, 90.4210, 52, 50, 2004),
    ("SS-02", "Riverside Substation", "substation", "Z-RIV", 3, 140, "MVA", 61, 23.8022, 90.3815, 20, 60, 2011),
    ("SS-03", "Eastfield Substation", "substation", "Z-EAS", 3, 120, "MVA", 72, 23.8155, 90.4402, 80, 42, 2016),
    ("SS-04", "Southbank Substation", "substation", "Z-SOU", 4, 90, "MVA", 48, 23.7901, 90.4188, 57, 84, 2019),
    ("HO-01", "Aurora Central Hospital", "hospital", "Z-CEN", 1, 120, "Beds", 84, 23.8112, 90.4158, 55, 46, 1987),
    ("HO-02", "Northgate Community Hospital", "hospital", "Z-NOR", 2, 64, "Beds", 71, 23.8265, 90.4102, 42, 22, 2013),
    ("HO-03", "Riverside Clinic", "hospital", "Z-RIV", 3, 28, "Beds", 66, 23.8041, 90.3878, 26, 68, 2018),
    ("WP-01", "River Intake Pump Station", "water_pump", "Z-RIV", 2, 90, "ML/day", 78, 23.8009, 90.3801, 14, 56, 1995),
    ("WP-02", "Central Distribution Pump", "water_pump", "Z-CEN", 3, 70, "ML/day", 64, 23.8098, 90.4177, 50, 56, 2006),
    ("WP-03", "Southbank Booster Pump", "water_pump", "Z-SOU", 4, 45, "ML/day", 52, 23.7928, 90.4211, 60, 78, 2017),
    ("WT-01", "Vale Water Treatment Works", "water_treatment", "Z-RIV", 1, 180, "ML/day", 76, 23.7975, 90.3769, 10, 66, 1991),
    ("SC-01", "Central Model School", "school", "Z-CEN", 4, 900, "Pupils", 88, 23.8069, 90.4145, 44, 42, 1952),
    ("SC-02", "Northgate High School", "school", "Z-NOR", 4, 700, "Pupils", 79, 23.8288, 90.4088, 48, 10, 2001),
    ("RE-01", "Riverside Residences", "residential", "Z-RIV", 3, 2400, "Units", 92, 23.8033, 90.3942, 30, 62, 2003),
    ("RE-02", "Eastfield Housing Estate", "residential", "Z-EAS", 3, 3100, "Units", 86, 23.8171, 90.4355, 74, 36, 2012),
    ("RE-03", "Southbank Apartments", "residential", "Z-SOU", 4, 1800, "Units", 74, 23.7884, 90.4109, 52, 88, 2020),
    ("CM-01", "Galleria Aurora Mall", "commercial", "Z-CEN", 5, 260, "Shops", 70, 23.8131, 90.4244, 60, 40, 2014),
    ("CM-02", "Northgate Business Park", "commercial", "Z-NOR", 5, 190, "Units", 63, 23.8218, 90.4155, 38, 26, 2010),
    ("CM-03", "Southbank Logistics Hub", "commercial", "Z-SOU", 5, 140, "Units", 58, 23.7952, 90.4244, 64, 76, 2021),
    ("TX-01", "Central Telecom Exchange", "telecom", "Z-CEN", 2, 60, "Racks", 69, 23.8126, 90.4189, 58, 52, 2008),
    ("TX-02", "Eastfield Edge Node", "telecom", "Z-EAS", 4, 30, "Racks", 57, 23.8192, 90.4318, 84, 34, 2022),
]

ASSET_NOTES = {
    "PS-01": "Primary generation for Aurora Vale. Two combined-cycle units, one currently on standby.",
    "SS-01": "Feeds the central district ring including the main hospital and telecom exchange.",
    "HO-01": "Regional trauma centre. Has a 6-hour diesel generator, see dependency redundancy.",
    "WT-01": "Treats river abstraction; feeds every pumping station downstream.",
    "WP-01": "Raw water intake. No on-site backup power, tripping it stops treatment over time.",
    "CM-01": "Largest commercial draw in the district. Non-critical but high revenue exposure.",
}

# (source, target, dependency_type, impact_weight, redundancy, description)
DEPENDENCIES = [
    ("PS-01", "SS-01", "power", 1.0, 0.05, "Central substation takes its full feed from PS-01"),
    ("PS-01", "SS-02", "power", 0.85, 0.10, "Riverside feed shared with PS-02 via the ring"),
    ("PS-02", "SS-01", "power", 0.55, 0.35, "Secondary feed to the central ring"),
    ("PS-02", "SS-03", "power", 0.80, 0.15, "Eastfield substation fed from Northgate turbine"),
    ("PS-02", "SS-04", "power", 0.70, 0.20, "Southbank fed from Northgate turbine"),
    ("SS-01", "HO-01", "power", 0.95, 0.45, "Trauma centre has 6h diesel backup (45% autonomy)"),
    ("SS-02", "HO-03", "power", 0.80, 0.30, "Clinic has a small UPS only"),
    ("SS-03", "HO-02", "power", 0.85, 0.25, "Community hospital on substation feed only"),
    ("SS-02", "WP-01", "power", 1.00, 0.00, "Intake pumps have no backup power"),
    ("SS-01", "WP-02", "power", 0.95, 0.05, "Distribution pump backup is out for service"),
    ("SS-04", "WP-03", "power", 0.90, 0.10, "Booster pump feed"),
    ("SS-02", "WT-01", "power", 1.00, 0.00, "Treatment works depends on Riverside substation"),
    ("PS-01", "WT-01", "power", 0.60, 0.20, "Direct high voltage feed for aeration blowers"),
    ("SS-01", "TX-01", "power", 0.90, 0.50, "Exchange has a battery room with 4h autonomy"),
    ("SS-03", "TX-02", "power", 0.85, 0.15, "Edge node has diesel generator"),
    ("SS-01", "SC-01", "power", 0.70, 0.10, "School has no generator"),
    ("SS-03", "SC-02", "power", 0.70, 0.10, "School has no generator"),
    ("SS-02", "RE-01", "power", 0.85, 0.05, "Riverside residences"),
    ("SS-03", "RE-02", "power", 0.85, 0.05, "Eastfield housing estate"),
    ("SS-04", "RE-03", "power", 0.80, 0.10, "Southbank apartments have a shared UPS"),
    ("SS-01", "CM-01", "power", 0.75, 0.15, "Mall has a small standby set"),
    ("SS-03", "CM-02", "power", 0.70, 0.15, "Business park"),
    ("SS-04", "CM-03", "power", 0.65, 0.10, "Logistics hub has cold-chain exposure"),
    ("WT-01", "WP-01", "water", 0.55, 0.20, "Treated water pressure is required for intake control"),
    ("WT-01", "WP-02", "water", 0.50, 0.25, "Distribution pressure from the works"),
]

# code, name, category, capacity, unit, hourly cost, mobilisation minutes, zone
RESOURCES = [
    ("GEN-01", "Atlas 250kVA Generator", "generator", 100, "kVA", 180, 25, "Z-CEN"),
    ("GEN-02", "Volt 120kVA Generator", "generator", 60, "kVA", 120, 35, "Z-NOR"),
    ("GEN-03", "Ampere 45kVA Generator", "generator", 30, "kVA", 85, 45, "Z-EAS"),
    ("GEN-04", "Harbour 200kVA Generator", "generator", 80, "kVA", 150, 30, "Z-RIV"),
    ("TK-01", "Tanker Vale 12", "water_tanker", 12, "kL", 95, 20, "Z-CEN"),
    ("TK-02", "Tanker Vale 18", "water_tanker", 18, "kL", 110, 40, "Z-RIV"),
    ("CR-01", "Central Repair Crew A", "crew", 1, "crew", 240, 15, "Z-CEN"),
    ("CR-02", "Northgate Repair Crew B", "crew", 1, "crew", 230, 30, "Z-NOR"),
    ("CR-03", "Riverside Repair Crew C", "crew", 1, "crew", 220, 25, "Z-RIV"),
    ("EQ-01", "High-Reach Lift 1", "equipment", 1, "unit", 160, 60, "Z-SOU"),
    ("EQ-02", "Cable Pulling Rig", "equipment", 1, "unit", 130, 50, "Z-EAS"),
    ("MS-01", "Emergency Medical Crate Set", "medical_supply", 30, "sets", 70, 10, "Z-CEN"),
]

# An intentionally tight allocation problem for the A02 demonstration.
DEMO_DEMAND = [
    ("HO-01", 60, 1, ["generator"], 240, 3.0),
    ("WP-02", 40, 2, ["generator"], 240, 2.5),
    ("CM-01", 30, 5, ["generator"], 480, 1.5),
]

RESOURCE_ELIGIBILITY = {
    "generator": ["hospital", "water_pump", "water_treatment", "telecom", "residential", "school", "commercial", "substation"],
    "water_tanker": ["residential", "hospital", "school"],
    "crew": ["power_station", "substation", "water_pump", "water_treatment", "hospital", "telecom", "residential", "school", "commercial"],
    "equipment": ["power_station", "substation", "water_pump", "water_treatment", "telecom"],
    "medical_supply": ["hospital"],
}

USERS = [
    {
        "email": "admin@symbiotic.city",
        "password": "Admin#2026",
        "full_name": "Mira Chowdhury",
        "role": "super_admin",
        "job_title": "Platform Administrator",
        "phone": "+880 1700 000 001",
        "avatar_color": "#38bdf8",
    },
    {
        "email": "operator@symbiotic.city",
        "password": "Operator#2026",
        "full_name": "Rafiul Islam",
        "role": "city_operator",
        "job_title": "Watch Commander, City Operations",
        "phone": "+880 1700 000 002",
        "avatar_color": "#34d399",
    },
    {
        "email": "engineer@symbiotic.city",
        "password": "Engineer#2026",
        "full_name": "Nadia Rahman",
        "role": "field_engineer",
        "job_title": "Senior Grid Engineer",
        "phone": "+880 1700 000 003",
        "avatar_color": "#f59e0b",
    },
    {
        "email": "engineer2@symbiotic.city",
        "password": "Engineer#2026",
        "full_name": "Tanvir Hossain",
        "role": "field_engineer",
        "job_title": "Field Engineer, Water",
        "phone": "+880 1700 000 004",
        "avatar_color": "#fbbf24",
    },
    {
        "email": "analyst@symbiotic.city",
        "password": "Analyst#2026",
        "full_name": "Sadia Karim",
        "role": "city_analyst",
        "job_title": "Resilience Analyst",
        "phone": "+880 1700 000 005",
        "avatar_color": "#a78bfa",
    },
]

SYSTEM_SETTINGS = [
    {
        "key": "cascade_threshold",
        "value": "0.35",
        "label": "Default cascade threshold",
        "description": "Supply deficit above which a dependent asset is modelled as failed.",
        "section": "simulation",
        "value_type": "number",
    },
    {
        "key": "max_cascade_depth",
        "value": "6",
        "label": "Maximum cascade depth",
        "description": "How many dependency hops a simulation will traverse.",
        "section": "simulation",
        "value_type": "number",
    },
    {
        "key": "default_horizon_hours",
        "value": "12",
        "label": "Optimisation horizon (hours)",
        "description": "Budget used when converting mobilisation time into a constraint.",
        "section": "optimization",
        "value_type": "number",
    },
    {
        "key": "must_serve_priority",
        "value": "1",
        "label": "Must-serve priority class",
        "description": "Priority class the optimiser is required to serve in full.",
        "section": "optimization",
        "value_type": "number",
    },
    {
        "key": "auto_create_incident",
        "value": "true",
        "label": "Create incident from simulation",
        "description": "Allow operators to open an incident directly from a simulation run.",
        "section": "workflow",
        "value_type": "boolean",
    },
    {
        "key": "notification_retention_days",
        "value": "90",
        "label": "Notification retention (days)",
        "description": "How long read notifications are kept before pruning.",
        "section": "general",
        "value_type": "number",
    },
    {
        "key": "session_timeout_minutes",
        "value": "480",
        "label": "Session lifetime (minutes)",
        "description": "Idle session lifetime before re-authentication is required.",
        "section": "security",
        "value_type": "number",
    },
    {
        "key": "demo_mode_banner",
        "value": "true",
        "label": "Show synthetic data banner",
        "description": "Reminds judges and operators that the city is a synthetic demonstration.",
        "section": "general",
        "value_type": "boolean",
    },
]
