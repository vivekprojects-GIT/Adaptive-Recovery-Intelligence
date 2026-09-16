from datetime import datetime
from sqlalchemy import String, Integer, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class Customer(Base):
    __tablename__ = "customers"

    customer_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(60))
    balance: Mapped[float] = mapped_column(Float)
    credit_limit: Mapped[float] = mapped_column(Float)
    utilization: Mapped[float] = mapped_column(Float)
    tenure_years: Mapped[int] = mapped_column(Integer)
    sms_responsive: Mapped[bool] = mapped_column(Boolean, default=False)
    app_user: Mapped[bool] = mapped_column(Boolean, default=False)
    hardship_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    missed_payments: Mapped[int] = mapped_column(Integer, default=0)
    payment_history: Mapped[float] = mapped_column(Float, default=0.8)  # 0-1 on-time ratio
    days_past_due: Mapped[int] = mapped_column(Integer, default=0)
    risk_score: Mapped[float] = mapped_column(Float, default=0.0)
    nudge_score: Mapped[float] = mapped_column(Float, default=0.0)
    self_cure_score: Mapped[float] = mapped_column(Float, default=0.0)
    segment: Mapped[str] = mapped_column(String(40), default="Sure Thing")
    treatment: Mapped[str] = mapped_column(String(60), default="")
    outcome: Mapped[str] = mapped_column(String(40), default="Pending")
    is_persona: Mapped[bool] = mapped_column(Boolean, default=False)
    persona_note: Mapped[str] = mapped_column(Text, default="")


class Journey(Base):
    __tablename__ = "journeys"

    journey_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    journey_code: Mapped[str] = mapped_column(String(10))
    journey_name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    cost_per_contact: Mapped[float] = mapped_column(Float, default=0.5)


class BanditStat(Base):
    __tablename__ = "bandit_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    journey_id: Mapped[int] = mapped_column(ForeignKey("journeys.journey_id"))
    successes: Mapped[int] = mapped_column(Integer, default=1)
    failures: Mapped[int] = mapped_column(Integer, default=1)


class Intervention(Base):
    __tablename__ = "interventions"

    intervention_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.customer_id"))
    journey_id: Mapped[int] = mapped_column(ForeignKey("journeys.journey_id"))
    sampled_score: Mapped[float] = mapped_column(Float, default=0.0)
    outcome: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
