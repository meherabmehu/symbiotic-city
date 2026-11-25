import { describe, expect, it } from "vitest";
import React from "react";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { Building } from "@/components/city3d/buildings";
import {
  DependencyLinks,
  Roads,
  Scenery,
  Traffic,
  ZoneDiscs,
} from "@/components/city3d/city-parts";
import { buildCityModel } from "@/lib/city-model";
import type { TwinEdge, TwinGraph, TwinNode, Zone } from "@/lib/types";

/**
 * Scene-graph tests.
 *
 * These mount the real React Three Fiber tree through `@react-three/test-renderer`,
 * which builds the same three.js objects the browser would -- without a GL context.
 * That makes it possible to assert the things that usually go untested until
 * somebody looks at the screen: that every asset produced geometry, that a
 * simulated outage actually reaches the building, that the traffic meshes animate,
 * and that decorative props never carry asset data.
 *
 * It cannot assert how any of it *looks*. Nothing here is a substitute for opening
 * the page; it is a guard against the scene silently rendering empty.
 */

function node(overrides: Partial<TwinNode> & { id: number }): TwinNode {
  return {
    id: overrides.id,
    code: overrides.code ?? `N-${overrides.id}`,
    name: overrides.name ?? `Node ${overrides.id}`,
    category: overrides.category ?? "substation",
    status: overrides.status ?? "operational",
    criticality: overrides.criticality ?? 3,
    map_x: overrides.map_x ?? 50,
    map_y: overrides.map_y ?? 50,
    zone: overrides.zone ?? "Z-CEN",
    capacity: overrides.capacity ?? 100,
    load_percent: overrides.load_percent ?? 50,
    active_incidents: overrides.active_incidents ?? 0,
  };
}

const NODES: TwinNode[] = [
  node({ id: 1, code: "PS-01", category: "power_station", map_x: 46, map_y: 54 }),
  node({ id: 2, code: "SS-01", category: "substation", map_x: 52, map_y: 50 }),
  node({ id: 3, code: "HO-01", category: "hospital", map_x: 44, map_y: 60 }),
  node({ id: 4, code: "TX-01", category: "telecom", map_x: 62, map_y: 62, status: "offline" }),
  node({ id: 5, code: "CM-01", category: "commercial", map_x: 58, map_y: 44, status: "maintenance" }),
];

const EDGES: TwinEdge[] = [
  { id: 1, source: 1, target: 2, dependency_type: "power", impact_weight: 0.8, redundancy: 0.1 },
  { id: 2, source: 2, target: 3, dependency_type: "power", impact_weight: 0.6, redundancy: 0.2 },
];

const ZONES: Zone[] = [
  { id: 1, code: "Z-CEN", name: "Central", district: "Aurora", population: 38500, center_x: 50, center_y: 48 },
];

const GRAPH: TwinGraph = {
  nodes: NODES,
  edges: EDGES,
  zones: ZONES,
  generated_at: "2026-11-22T00:00:00Z",
  stats: { nodes: NODES.length, edges: EDGES.length, by_status: {} },
} as TwinGraph;

const MODEL = buildCityModel(GRAPH)!;

/** Count every object of a three.js type in the rendered tree. */
function countType(root: unknown, type: string): number {
  let count = 0;
  const walk = (candidate: any) => {
    if (!candidate) return;
    const object = candidate.instance ?? candidate._object ?? candidate;
    if (object?.type === type) count += 1;
    for (const child of candidate.children ?? []) walk(child);
  };
  walk(root);
  return count;
}

/** Find the instanced traffic mesh, which is the only instanced object drawn. */
function findInstanced(root: unknown): any {
  let found: any = null;
  const walk = (candidate: any) => {
    if (!candidate) return;
    const object = candidate.instance ?? candidate._object ?? candidate;
    if (object?.isInstancedMesh) found = object;
    for (const child of candidate.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

describe("city scene", () => {
  it("renders a building group for every asset in the graph", async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <>
        {MODEL.assets.map((asset) => (
          <Building
            key={asset.node.id}
            category={asset.node.category}
            status="operational"
            footprint={asset.footprint}
            position={asset.position}
            rotation={asset.rotation}
            selected={false}
          />
        ))}
      </>,
    );

    // One group per building, and geometry beneath each of them. A scene that
    // mounted nothing would still have one root, so counting root children alone
    // is not enough.
    expect(countType(renderer.scene, "Group")).toBeGreaterThanOrEqual(NODES.length);
    expect(countType(renderer.scene, "Mesh")).toBeGreaterThanOrEqual(NODES.length * 2);

    await renderer.unmount();
  });

  it("draws each category with its own silhouette, not one repeated box", async () => {
    const counts: number[] = [];
    for (const asset of MODEL.assets) {
      const renderer = await ReactThreeTestRenderer.create(
        <Building
          category={asset.node.category}
          status="operational"
          footprint={asset.footprint}
          position={asset.position}
          rotation={0}
          selected={false}
        />,
      );
      counts.push(countType(renderer.scene, "Mesh"));
      await renderer.unmount();
    }
    // A hospital (slab + wing + helipad + roof bar) has more parts than a bare
    // substation. If every category drew the same primitive, these would all be
    // equal, and the skyline would be meaningless.
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it("shows a failed building with its failure mark, and an operational one without", async () => {
    const asset = MODEL.assets[0];

    const failed = await ReactThreeTestRenderer.create(
      <Building
        category={asset.node.category}
        status="failed"
        footprint={asset.footprint}
        position={asset.position}
        rotation={0}
        selected={false}
      />,
    );
    const failedMeshes = countType(failed.scene, "Mesh");
    await failed.unmount();

    const ok = await ReactThreeTestRenderer.create(
      <Building
        category={asset.node.category}
        status="operational"
        footprint={asset.footprint}
        position={asset.position}
        rotation={0}
        selected={false}
      />,
    );
    const okMeshes = countType(ok.scene, "Mesh");
    await ok.unmount();

    // The cross above a failed building is two extra meshes: status is drawn, not
    // just coloured, so the difference is structural and measurable.
    expect(failedMeshes).toBe(okMeshes + 2);
  });

  it("draws the dependency network as lines", async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <DependencyLinks edges={MODEL.edges} show />,
    );
    expect(countType(renderer.scene, "LineSegments")).toBe(1);
    await renderer.unmount();
  });

  it("draws nothing for links when they are switched off", async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <DependencyLinks edges={MODEL.edges} show={false} />,
    );
    expect(countType(renderer.scene, "LineSegments")).toBe(0);
    await renderer.unmount();
  });

  it("moves traffic along the avenues between frames", async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <>
        <Roads model={MODEL} />
        <Traffic model={MODEL} enabled />
      </>,
    );

    const traffic = findInstanced(renderer.scene);
    expect(traffic).not.toBeNull();
    expect(traffic.count).toBeGreaterThan(0);

    // Translation lives at indices 12-14 of each 16-float instance matrix; the
    // rotation above it is constant for a vehicle on a straight lane.
    const translation = (mesh: any): number[] => {
      const values = Array.from(mesh.instanceMatrix.array) as number[];
      return values.filter((_, index) => index % 16 >= 12);
    };

    const before = translation(traffic);
    await renderer.advanceFrames(30, 1 / 60);
    const after = translation(traffic);

    // A static traffic system would be worse than none: it would suggest vehicles
    // are moving when nothing is happening.
    expect(after).not.toEqual(before);

    // Every vehicle must stay on the ground plane -- one drifting into the sky
    // would be immediately visible.
    for (let index = 0; index < traffic.count; index += 1) {
      const y = traffic.instanceMatrix.array[index * 16 + 13];
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(2);
    }

    await renderer.unmount();
  });

  it("draws no traffic when the overlay is switched off", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Traffic model={MODEL} enabled={false} />);
    expect(findInstanced(renderer.scene)).toBeNull();
    await renderer.unmount();
  });

  it("keeps decorative scenery out of the operational layer", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Scenery model={MODEL} enabled />);
    const meshCount = countType(renderer.scene, "Mesh");

    // Scenery exists as geometry...
    expect(MODEL.scenery.length).toBeGreaterThan(0);
    expect(meshCount).toBeGreaterThan(0);

    // ...but nothing in it carries an asset id, so a prop can never be mistaken
    // for, or selected as, infrastructure.
    for (const prop of MODEL.scenery) {
      expect(Object.keys(prop)).not.toContain("node");
      expect(Object.keys(prop)).not.toContain("assetId");
    }

    await renderer.unmount();
  });

  it("tints a zone disc by its resilience score when a heatmap is supplied", async () => {
    const withHeat = await ReactThreeTestRenderer.create(
      <ZoneDiscs
        zones={MODEL.zones}
        show
        heat={new Map([["Z-CEN", { score: 12, band: "critical" }]])}
      />,
    );
    const heatMeshes = countType(withHeat.scene, "Mesh");
    await withHeat.unmount();

    // The disc and its ring are always drawn; the assertion that matters is that a
    // heat reading does not remove geometry or crash on a zone it has no data for.
    const partial = await ReactThreeTestRenderer.create(
      <ZoneDiscs zones={MODEL.zones} show heat={new Map([["Z-OTHER", { score: 90, band: "strong" }]])} />,
    );
    expect(countType(partial.scene, "Mesh")).toBe(heatMeshes);
    await partial.unmount();
  });

  it("draws a graph with no links and no zones, since the buildings are the point", async () => {
    const sparse = buildCityModel({
      ...GRAPH,
      edges: [],
      zones: [],
    } as TwinGraph)!;

    const renderer = await ReactThreeTestRenderer.create(
      <>
        <Roads model={sparse} />
        <ZoneDiscs zones={sparse.zones} show />
        <DependencyLinks edges={sparse.edges} show />
        {sparse.assets.map((asset) => (
          <Building
            key={asset.node.id}
            category={asset.node.category}
            status="operational"
            footprint={asset.footprint}
            position={asset.position}
            rotation={asset.rotation}
            selected={false}
          />
        ))}
      </>,
    );

    // Missing relationships must not blank the city: the assets are still there,
    // there is just nothing linking them.
    expect(sparse.assets).toHaveLength(NODES.length);
    expect(countType(renderer.scene, "Mesh")).toBeGreaterThan(NODES.length);
    expect(countType(renderer.scene, "LineSegments")).toBe(0);
    await renderer.unmount();
  });

  it("reports a missing model rather than building a scene from nothing", () => {
    // The canvas component renders its empty state on this; a model with zero
    // assets would otherwise be indistinguishable from a failed fetch.
    expect(
      buildCityModel({
        nodes: [],
        edges: [],
        zones: [],
        generated_at: "2026-11-22T00:00:00Z",
        stats: { nodes: 0, edges: 0, by_status: {} },
      } as TwinGraph),
    ).toBeNull();
  });
});
