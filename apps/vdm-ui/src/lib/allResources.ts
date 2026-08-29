export interface AllResourceRow {
  key: string;
  type: "VM" | "LXC" | "Docker";
  name: string;
  id: string; // resource identifier: VM/LXC name, Docker container id
  state: string;
  nodeName: string;
  nodeDisplayName: string;
  detail: string;
  href: string;
}

interface VmLike { name: string; state: string; nodeName: string; nodeDisplayName: string; }
interface LxcLike { name: string; state: string; nodeName: string; nodeDisplayName: string; }
interface DockerLike { id: string; name: string; state: string; nodeName: string; nodeDisplayName: string; image?: string; status?: string; }

export function buildAllResourceRows(vms: VmLike[], lxc: LxcLike[], docker: DockerLike[]): AllResourceRow[] {
  return [
    ...vms.map((vm): AllResourceRow => ({
      key: `vm:${vm.nodeName}:${vm.name}`,
      type: "VM",
      name: vm.name,
      id: vm.name,
      state: vm.state,
      nodeName: vm.nodeName,
      nodeDisplayName: vm.nodeDisplayName,
      detail: "Virtual machine",
      href: `/inventory/vm/${encodeURIComponent(vm.nodeName)}/${encodeURIComponent(vm.name)}`,
    })),
    ...lxc.map((ct): AllResourceRow => ({
      key: `lxc:${ct.nodeName}:${ct.name}`,
      type: "LXC",
      name: ct.name,
      id: ct.name,
      state: ct.state,
      nodeName: ct.nodeName,
      nodeDisplayName: ct.nodeDisplayName,
      detail: "Linux container",
      href: `/inventory/lxc/${encodeURIComponent(ct.nodeName)}/${encodeURIComponent(ct.name)}`,
    })),
    ...docker.map((ct): AllResourceRow => ({
      key: `docker:${ct.nodeName}:${ct.id}`,
      type: "Docker",
      name: ct.name,
      id: ct.id,
      state: ct.state,
      nodeName: ct.nodeName,
      nodeDisplayName: ct.nodeDisplayName,
      detail: ct.image || "Docker container",
      href: `/inventory/docker/${encodeURIComponent(ct.nodeName)}/${encodeURIComponent(ct.id)}`,
    })),
  ];
}
