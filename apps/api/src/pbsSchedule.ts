// The schedule rule lives in @auxinux/shared so VDM's datacenter-wide PBS
// jobs fire exactly like the node's own.
export { isPbsJobDue, type PbsJobSchedule } from "@auxinux/shared";
