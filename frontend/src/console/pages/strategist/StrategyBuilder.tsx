import { BookOpen, FilePenLine, Lightbulb, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Page, PageHeader, Tabs } from "../../ui/ui";
import Suggested from "./builder/Suggested";
import Library from "./builder/Library";
import GuidedBuild from "./builder/GuidedBuild";
import DraftFromBrief from "./builder/DraftFromBrief";

type Tab = "suggested" | "library" | "guided" | "ai";

export default function StrategyBuilder() {
  const { id } = useParams();
  const [tab, setTab] = useState<Tab>(id ? "guided" : "suggested");
  useEffect(() => { if (id) setTab("guided"); }, [id]);
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Strategy Builder" subtitle={id ? `${id} · editing` : "Start from a suggestion, clone a strategy, or build one"}
        crumbs={[{ label: "Strategies", to: "/strategies" }, { label: "Builder" }]} />
      <div className="bg-surface px-6"><Tabs<Tab> active={tab} onChange={(t) => { setTab(t); if (t !== "guided" && id) navigate("/builder"); }} tabs={[
        { id: "suggested", label: "Suggested", icon: <Lightbulb className="h-3.5 w-3.5" /> },
        { id: "library", label: "Strategy Library", icon: <BookOpen className="h-3.5 w-3.5" /> },
        { id: "guided", label: "Guided Build", icon: <Wrench className="h-3.5 w-3.5" /> },
        { id: "ai", label: "Draft from a brief", icon: <FilePenLine className="h-3.5 w-3.5" /> },
      ]} /></div>
      <Page>
        {tab === "suggested" && <Suggested />}
        {tab === "library" && <Library />}
        {tab === "guided" && <GuidedBuild id={id} />}
        {tab === "ai" && <DraftFromBrief />}
      </Page>
    </>
  );
}
