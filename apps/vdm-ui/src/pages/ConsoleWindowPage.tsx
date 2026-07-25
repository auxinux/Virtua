import { useSearchParams } from "react-router-dom";
import { ConsoleModal, type ConsoleMode } from "@/components/ConsoleModal";

export default function ConsoleWindowPage() {
  const [params] = useSearchParams();
  const type = params.get("type");
  const mode = params.get("mode");
  const node = params.get("node") ?? "";
  const name = params.get("name") ?? "";
  if (!(["vms", "lxc", "docker"].includes(type ?? "") && ["term", "vnc", "spice", "rdp"].includes(mode ?? "") && node && name)) {
    return <div className="flex h-screen items-center justify-center bg-vdm-bg text-vdm-danger">Invalid console URL</div>;
  }
  return <ConsoleModal open standalone onClose={() => window.close()} type={type as "vms" | "lxc" | "docker"} node={node} name={name} title={params.get("title") ?? name} mode={mode as ConsoleMode} />;
}
