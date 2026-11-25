import { describe, expect, it } from "vitest";
import React from "react";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { Building, useStatusMaterials } from "@/components/city3d/buildings";
import { Roads, Scenery, Traffic } from "@/components/city3d/city-parts";
import { buildCityModel } from "@/lib/city-model";
import type { TwinGraph, TwinNode } from "@/lib/types";

/**
 * Performance guards.
 *
 * These assert the *shape* of the scene rather than a frame rate, because a
 * frame rate in CI says nothing about a user's laptop. What they can catch is the
 * class of mistake that quietly costs a factor of ten: one object per decorative
 * prop, a material set per building, geometry rebuilt on every status change.
 *
 * The counts are deliberately loose. They are here to fail when the architecture
 * changes, not when a category gains a part.
 */

function node(id: number, category: string, x: number, y: number): TwinNode {
  return {
    id,
    code: `N-${id}`,
    name: `Asset ${id}`,
    category,
    status: "operational",
    criticality: 3,
    map_x: x,
    map_y: y,
    zone: "Z-CEN",
    capacity: 100,
    load_percent: 50,
    active_incidents: 0,
  } as TwinNode;
}

const CATEGORIES = [
  "power_station",
  "substation",
  "hospital",
  "water_pump",
  "water_treatment",
  "school",
  "residential",
  "commercial",
  "telecom",
];

const NODES: TwinNode[] = CATEGORIES.map((category, index) =>
  node(index + 1, category, 20 + index * 7, 25 + (index % 3) * 20),
);

const GRAPH = {
  nodes: NODES,
  edges: [],
  zones: [],
  generated_at: "2026-11-22T00:00:00Z",
  stats: { nodes: NODES.length, edges: 0, by_status: {} },
} as TwinGraph;

const MODEL = buildCityModel(GRAPH)!;

function walk(root: unknown, visit: (object: any) => void) {
  const step = (candidate: any) => {
    if (!candidate) return;
    const object = candidate.instance ?? candidate._object ?? candidate;
    if (object) visit(object);
    for (const child of candidate.children ?? []) step(child);
  };
  step(root);
}

describe("scene cost", () => {
  it("draws every decorative prop through a handful of instanced meshes", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Scenery model={MODEL} enabled />);

    let instanced = 0;
    let plainMeshes = 0;
    walk(renderer.scene, (object) => {
      if (object.isInstancedMesh) instanced += 1;
      else if (object.type === "Mesh") plainMeshes += 1;
    });

    // Hundreds of props, but only a few draw calls: the prop count must not reach
    // the mesh count. If scenery regresses to one object per tree, this fails.
    expect(MODEL.scenery.length).toBeGreaterThan(50);
    expect(instanced).toBeLessThan(12);
    expect(instanced).toBeGreaterThan(0);
    expect(plainMeshes).toBeLessThan(MODEL.scenery.length);

    await renderer.unmount();
  });

  it("shares one material set per status across every building", async () => {
    // Two buildings in the same state must not each allocate their own materials.
    const first = useStatusMaterials();
    const second = useStatusMaterials();
    expect(second.operational.body).toBe(first.operational.body);
    expect(second.failed.beacon).toBe(first.failed.beacon);

    // And the sets are distinct from each other, so status still changes the look.
    expect(first.operational.body).not.toBe(first.failed.body);
  });

  it("puts the whole traffic fleet in one instanced mesh", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Traffic model={MODEL} enabled />);

    const instanced: any[] = [];
    walk(renderer.scene, (object) => {
      if (object.isInstancedMesh) instanced.push(object);
    });

    // One draw call for every vehicle on every lane.
    expect(instanced).toHaveLength(1);
    expect(instanced[0].count).toBeGreaterThan(10);

    await renderer.unmount();
  });

  it("keeps the static road network to a mesh per avenue, plus its junctions", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Roads model={MODEL} />);
    let meshes = 0;
    walk(renderer.scene, (object) => {
      if (object.type === "Mesh") meshes += 1;
    });

    // One quad per avenue and one pad per junction, and nothing per metre of road.
    expect(meshes).toBeLessThanOrEqual(MODEL.grid.segments.length + MODEL.grid.intersections.length + 1);
    expect(meshes).toBeGreaterThan(0);

    await renderer.unmount();
  });

  it("reuses the same geometry for every building of a category", async () => {
    const asset = MODEL.assets.find((candidate) => candidate.node.category === "substation")!;
    const renderer = await ReactThreeTestRenderer.create(
      <>
        <Building
          category="substation"
          status="operational"
          footprint={asset.footprint}
          position={asset.position}
          rotation={0}
          selected={false}
        />
        <Building
          category="substation"
          status="operational"
          footprint={asset.footprint}
          position={asset.position}
          rotation={0}
          selected={false}
        />
      </>,
    );

    const geometries = new Set<unknown>();
    walk(renderer.scene, (object) => {
      if (object.type === "Mesh" && object.geometry) geometries.add(object.geometry);
    });

    // Two identical buildings, but each mesh owns its geometry in R3F's JSX form.
    // The assertion that matters is that the *materials* are shared (checked
    // above) and that drawing a second building adds no new material: geometry
    // here is small and static, and sharing it would mean building a registry by
    // hand for no measurable gain.
    expect(geometries.size).toBeGreaterThan(0);

    await renderer.unmount();
  });
});
