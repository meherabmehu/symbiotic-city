import { describe, expect, it } from "vitest";
import React from "react";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import fs from "node:fs";
import { EmergencyTraffic, Markings, Traffic, TrafficSignals } from "@/components/city3d/city-parts";
import { buildCityModel } from "@/lib/city-model";
import type { TwinGraph } from "@/lib/types";

const graph = JSON.parse(
  fs.readFileSync("tests/unit/fixtures/twin-graph.json", "utf8"),
) as TwinGraph;
const model = buildCityModel(graph)!;

/**
 * React Three Fiber keeps its objects behind a wrapper, and the wrapper's shape has
 * changed between versions. Reading both is cheaper than tracking that.
 */
function instancedMeshes(scene: unknown): { count: number; matrix: Float32Array }[] {
  const found: { count: number; matrix: Float32Array }[] = [];
  const walk = (node: any) => {
    const object = node?.instance ?? node?._object ?? node;
    if (object?.isInstancedMesh) {
      found.push({ count: object.count, matrix: object.instanceMatrix.array });
    }
    for (const child of node?.children ?? []) walk(child);
  };
  walk(scene);
  return found;
}

function translations(entries: { count: number; matrix: Float32Array }) {
  const points: { x: number; z: number }[] = [];
  for (let index = 0; index < entries.count; index += 1) {
    points.push({
      x: entries.matrix[index * 16 + 12],
      z: entries.matrix[index * 16 + 14],
    });
  }
  return points;
}

describe("traffic scene", () => {
  it("never stacks two vehicles on the same spot", async () => {
    // Vehicles are placed by instanced matrices, not by React children, so a
    // layout bug does not throw -- it just draws a hundred cars inside each other.
    const renderer = await ReactThreeTestRenderer.create(<Traffic model={model} enabled />);
    const [traffic] = instancedMeshes(renderer.scene);
    expect(traffic.count).toBeGreaterThan(0);

    const points = translations(traffic);
    const distinct = new Set(points.map((point) => `${point.x.toFixed(1)},${point.z.toFixed(1)}`));
    expect(distinct.size).toBe(points.length);

    await renderer.unmount();
  });

  it("keeps every vehicle on a street rather than in a building", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Traffic model={model} enabled />);
    const [traffic] = instancedMeshes(renderer.scene);

    for (const point of translations(traffic)) {
      const onRoad = model.grid.segments.some((segment) => {
        const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
        const across = horizontal
          ? Math.abs(point.z - segment.z1)
          : Math.abs(point.x - segment.x1);
        const within = horizontal
          ? point.x >= Math.min(segment.x1, segment.x2) - 2 && point.x <= Math.max(segment.x1, segment.x2) + 2
          : point.z >= Math.min(segment.z1, segment.z2) - 2 && point.z <= Math.max(segment.z1, segment.z2) + 2;
        // Routes run on the right-hand side, so allow the lane offset plus a car's
        // half-width.
        return within && across < segment.width / 2 + 2.5;
      });
      expect(onRoad, `vehicle at ${point.x.toFixed(1)},${point.z.toFixed(1)} is off-street`).toBe(true);
    }

    await renderer.unmount();
  });

  it("draws an emergency vehicle per active incident, capped", async () => {
    const none = await ReactThreeTestRenderer.create(
      <EmergencyTraffic model={model} enabled incidents={0} />,
    );
    expect(instancedMeshes(none.scene).length).toBe(0);
    await none.unmount();

    const two = await ReactThreeTestRenderer.create(
      <EmergencyTraffic model={model} enabled incidents={2} />,
    );
    const meshes = instancedMeshes(two.scene);
    expect(meshes.length).toBe(2);
    expect(meshes[0].count).toBe(2);
    await two.unmount();

    // A bad afternoon must not fill the streets with them.
    const many = await ReactThreeTestRenderer.create(
      <EmergencyTraffic model={model} enabled incidents={40} />,
    );
    const capped = instancedMeshes(many.scene);
    expect(capped[0].count).toBe(6);
    await many.unmount();
  });

  it("paints markings only over streets", async () => {
    const renderer = await ReactThreeTestRenderer.create(<Markings model={model} />);
    const meshes = instancedMeshes(renderer.scene);
    expect(meshes.length).toBe(2);

    // Dashes down the centre line: every one must sit on an avenue's axis.
    for (const point of translations(meshes[0])) {
      const onAxis =
        model.grid.lines.some((x) => Math.abs(point.x - x) < 0.5) ||
        model.grid.zLines.some((z) => Math.abs(point.z - z) < 0.5);
      expect(onAxis).toBe(true);
    }

    await renderer.unmount();
  });

  it("puts a signal head on every junction", async () => {
    const renderer = await ReactThreeTestRenderer.create(<TrafficSignals model={model} enabled />);
    const [signals] = instancedMeshes(renderer.scene);
    expect(signals.count).toBe(model.grid.intersections.length * 4);
    await renderer.unmount();
  });
});
