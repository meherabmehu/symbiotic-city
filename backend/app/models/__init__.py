"""SQLAlchemy models. Importing this package registers every table."""
from app.models.identity import (  # noqa: F401
    PasswordResetToken,
    Permission,
    Role,
    SessionToken,
    SystemSetting,
    User,
    role_permissions,
    user_roles,
)
from app.models.infrastructure import (  # noqa: F401
    AssetCategory,
    AssetStatus,
    CityZone,
    InfrastructureAsset,
    InfrastructureDependency,
    InfrastructureStatusHistory,
)
from app.models.operations import (  # noqa: F401
    Incident,
    IncidentAsset,
    IncidentEvent,
    IncidentStatus,
    RepairTask,
    Resource,
    ResourceCategory,
    ResourceReservation,
    ReservationStatus,
    TaskStatus,
    TaskStatusHistory,
)
from app.models.simulation import (  # noqa: F401
    SimulationResult,
    SimulationRun,
    SimulationScenario,
    WhatIfObservation,
    WhatIfScenario,
)
from app.models.optimization import (  # noqa: F401
    OptimizationAssignment,
    OptimizationPlan,
    OptimizationRequest,
)
from app.models.workflow import IdempotencyKey, WorkflowEvent, WorkflowInstance  # noqa: F401
from app.models.system import AuditLog, Notification  # noqa: F401
