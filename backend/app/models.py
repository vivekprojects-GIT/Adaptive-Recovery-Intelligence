from sqlalchemy import String, Integer, Float, Boolean, Text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class Cohort(Base):
    """A group handed off by the client's collections system (DPD bucket x risk band)."""
    __tablename__ = "cohorts"

    cohort_id: Mapped[str] = mapped_column(String(10), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    dpd_bucket: Mapped[str] = mapped_column(String(20))
    client_risk_band: Mapped[str] = mapped_column(String(20))
    expected_payment: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Customer(Base):
    __tablename__ = "customers"

    customer_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cohort_id: Mapped[str] = mapped_column(String(10), index=True)
    name: Mapped[str] = mapped_column(String(60))
    balance: Mapped[float] = mapped_column(Float)
    credit_limit: Mapped[float] = mapped_column(Float)
    utilization: Mapped[float] = mapped_column(Float)
    tenure_years: Mapped[int] = mapped_column(Integer)
    sms_responsive: Mapped[bool] = mapped_column(Boolean, default=False)
    app_user: Mapped[bool] = mapped_column(Boolean, default=False)
    hardship_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    missed_payments: Mapped[int] = mapped_column(Integer, default=0)   # prior 12 months
    payment_history: Mapped[float] = mapped_column(Float, default=0.8)  # 0-1 on-time ratio
    days_past_due: Mapped[int] = mapped_column(Integer, default=0)
    # Provided by the client's existing risk model - not computed by ARI.
    client_risk_band: Mapped[str] = mapped_column(String(20))
    client_risk_score: Mapped[float] = mapped_column(Float)
    # ARI intervention-side scores.
    nudge_score: Mapped[float] = mapped_column(Float, default=0.0)
    self_cure_score: Mapped[float] = mapped_column(Float, default=0.0)
    segment: Mapped[str] = mapped_column(String(40), default="Sure Thing")
    is_persona: Mapped[bool] = mapped_column(Boolean, default=False)
    persona_note: Mapped[str] = mapped_column(Text, default="")


class Strategy(Base):
    """An intervention strategy in the client's playbook, with its historical record."""
    __tablename__ = "strategies"

    code: Mapped[str] = mapped_column(String(10), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    channel: Mapped[str] = mapped_column(String(60))
    offer: Mapped[str] = mapped_column(Text)
    timing: Mapped[str] = mapped_column(String(60))
    eligibility_rule: Mapped[str] = mapped_column(Text)
    cost_per_contact: Mapped[float] = mapped_column(Float)
    hist_successes: Mapped[int] = mapped_column(Integer)
    hist_failures: Mapped[int] = mapped_column(Integer)
