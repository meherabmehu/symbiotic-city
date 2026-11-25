import { describe, expect, it } from "vitest";
import React from "react";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { Building } from "@/components/city3d/buildings";
import { DependencyLinks, Ground, Roads, Scenery, Traffic, ZoneDiscs } from "@/components/city3d/city-parts";
import { buildCityModel } from "@/lib/city-model";
import fs from "node:fs";
import path from "node:path";

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "twin-graph.json"), "utf8"));

/**
 * Assembly test against a captured API payload.
 *
 * `fixtures/twin-graph.json` is the real response from `GET /api/twin/graph` --
 * 23 assets, 25 edges, 5 zones -- saved so this runs without a backend. The other
 * scene tests use small hand-built graphs, which is better for isolating a
 * behaviour but says nothing about whether the city actually assembles from what
 * the API sends. This is the one that would have caught a category the seed data
 * uses and the layout model does not.
 */
describe("full twin graph", () => {
  it("assembles the whole city from the captured payload", async () => {
    const model = buildCityModel(graph)!;
    const heat = new Map<string, { score: number; band: string }>(
      (graph.zones as { code: string }[]).map((z) => [z.code, { score: 55, band: "elevated" }]),
    );
    const r = await ReactThreeTestRenderer.create(
      <>
        <Ground />
        <ZoneDiscs zones={model.zones} heat={heat} show selectedZone="Z-CEN" />
        <Roads model={model} />
        <Scenery model={model} enabled />
        <Traffic model={model} enabled />
        {model.assets.map((a) => (
          <Building key={a.node.id} category={a.node.category} status="degraded"
            footprint={a.footprint} position={a.position} rotation={a.rotation} selected={a.node.id === model.assets[0].node.id}
            intensity={{ value: 72, emphasis: true }} />
        ))}
        <DependencyLinks edges={model.edges} show compromised={new Set([1,2])} selectedId={3} />
      </>,
    );
    let meshes = 0, instanced = 0, lines = 0;
    const walk = (c: any) => { const o = c.instance ?? c._object ?? c; if (o?.isInstancedMesh) instanced++; else if (o?.type === "Mesh") meshes++; else if (o?.type === "LineSegments") lines++; for (const k of c.children ?? []) walk(k); };
    walk(r.scene);
    // The payload's own counts, so a seed change that adds assets makes this test
    // fail loudly rather than quietly covering less.
    expect(model.assets).toHaveLength(23);
    expect(model.edges).toHaveLength(25);
    expect(model.zones).toHaveLength(5);

    expect(meshes).toBeGreaterThan(200);
    expect(instanced).toBeGreaterThan(0);
    expect(lines).toBe(1);
    await r.unmount();
  });
});
