// The label of each POPP node type, once for the whole web (spec: Catalog,
// rule 7). A complete Record over NodeType, so a type added to
// shared/popp.ts fails the typecheck until it has a label. Pure: `t` is a
// parameter, so the server's node:test runner tests it with both catalogs.

import type { TFunction } from "i18next";
import { NODE_TYPES, type NodeType } from "../../../server/shared/popp";

type CommonT = TFunction<"common">;

const NODE_TYPE_LABELS: Record<NodeType, (t: CommonT) => string> = {
  organization: (t) => t(($) => $.node_type.organization, { ns: "common" }),
  project: (t) => t(($) => $.node_type.project, { ns: "common" }),
  process: (t) => t(($) => $.node_type.process, { ns: "common" }),
  area: (t) => t(($) => $.node_type.area, { ns: "common" }),
  principle: (t) => t(($) => $.node_type.principle, { ns: "common" }),
};

export function isNodeType(type: string): type is NodeType {
  return (NODE_TYPES as readonly string[]).includes(type);
}

// A type this build does not know is shown as stored.
export function nodeTypeLabel(type: string, t: CommonT): string {
  return isNodeType(type) ? NODE_TYPE_LABELS[type](t) : type;
}
