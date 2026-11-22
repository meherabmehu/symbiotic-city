"""Authentication & identity schemas."""
from __future__ import annotations

import re
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.permissions import Role
from app.schemas.common import ORMModel

PASSWORD_PATTERN = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).{8,128}$")


def _validate_password(value: str) -> str:
    if not PASSWORD_PATTERN.match(value):
        raise ValueError(
            "Password must be at least 8 characters long and contain both letters and numbers."
        )
    return value


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Role = Role.CITY_OPERATOR
    job_title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)

    @field_validator("password")
    @classmethod
    def _pwd(cls, v: str) -> str:
        return _validate_password(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        cleaned = " ".join(v.split())
        if len(cleaned) < 2:
            raise ValueError("Please enter your full name.")
        return cleaned

    @field_validator("role")
    @classmethod
    def _role(cls, v: Role) -> Role:
        if v == Role.SUPER_ADMIN:
            raise ValueError("Super Admin accounts can only be created by an administrator.")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    remember: bool = False


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("password")
    @classmethod
    def _pwd(cls, v: str) -> str:
        return _validate_password(v)


class RoleInfo(ORMModel):
    key: str
    name: str
    description: str = ""


class UserSummary(ORMModel):
    id: int
    email: str
    full_name: str
    job_title: str | None = None
    phone: str | None = None
    avatar_color: str
    is_active: bool
    last_login_at: datetime | None = None
    created_at: datetime
    roles: list[RoleInfo] = []


class MeResponse(BaseModel):
    user: UserSummary
    permissions: list[str]
    roles: list[str]


class RegisterResponse(BaseModel):
    user: UserSummary
    message: str


class ForgotPasswordResponse(BaseModel):
    message: str
    # only populated outside production so the demo can be exercised without SMTP
    reset_token: str | None = None


class UpdateProfileRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    job_title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)
    avatar_color: str | None = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _pwd(cls, v: str) -> str:
        return _validate_password(v)


class AdminUserCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Role = Role.CITY_OPERATOR
    job_title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)

    @field_validator("password")
    @classmethod
    def _pwd(cls, v: str) -> str:
        return _validate_password(v)


class AdminUserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    job_title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)
    role: Role | None = None
    is_active: bool | None = None


class PasswordResetAdminRequest(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _pwd(cls, v: str) -> str:
        return _validate_password(v)
