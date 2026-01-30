"""
IBM i Agent Workflows

This module provides workflow examples for common IBM i administrative tasks.
Workflows coordinate multiple agents to accomplish complex multi-step operations.

Available workflows:
- Simple workflows: Single-agent focused tasks
- System admin workflows: Multi-agent system administration operations
- Database admin workflows: Database monitoring and optimization workflows
"""

from .capacity_planning import capacity_planning_workflow
from .database_performance_tuning import database_tuning_workflow
from .performance_investigation import performance_investigation_workflow
from .simple_performance_check import simple_performance_workflow
from .service_discovery import service_discovery_workflow
from .system_health_audit import system_health_audit_workflow
from .find_service_example import find_service_workflow

__all__ = [
    "capacity_planning_workflow",
    "database_tuning_workflow",
    "performance_investigation_workflow",
    "simple_performance_workflow",
    "service_discovery_workflow",
    "system_health_audit_workflow",
    "find_service_workflow",
]
