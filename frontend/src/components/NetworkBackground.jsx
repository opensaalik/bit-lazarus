import { useEffect, useRef } from "react";
import * as THREE from "three";

// A field of square "pixel" nodes drifting in 3D. Nearby nodes link with thin
// lines; as nodes move, links continuously form and break. Rendered on a
// transparent canvas so the white page shows through.
export default function NetworkBackground({ className }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = mount.clientWidth || 1;
    let height = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 1, 3000);
    camera.position.z = 380;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const BX = 360;
    const BY = 210;
    const BZ = 170;
    const COUNT = 96;
    const LINK_DIST = 96;
    const MAX_SEG = 2000;

    const positions = new Float32Array(COUNT * 3);
    const velocities = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);

    // Mostly ink-black squares with a scatter of ember / violet accents.
    const ink = new THREE.Color(0x141414);
    const ember = new THREE.Color(0xff5a1f);
    const violet = new THREE.Color(0x6b4cff);
    const pick = (i) => {
      const r = (i * 2654435761) % 10;
      if (r === 0 || r === 1) return ember;
      if (r === 2) return violet;
      return ink;
    };

    for (let i = 0; i < COUNT; i += 1) {
      positions[i * 3] = (Math.random() * 2 - 1) * BX;
      positions[i * 3 + 1] = (Math.random() * 2 - 1) * BY;
      positions[i * 3 + 2] = (Math.random() * 2 - 1) * BZ;
      const speed = 0.22;
      velocities[i * 3] = (Math.random() * 2 - 1) * speed;
      velocities[i * 3 + 1] = (Math.random() * 2 - 1) * speed;
      velocities[i * 3 + 2] = (Math.random() * 2 - 1) * speed;
      const c = pick(i);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    nodeGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const nodeMat = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true });
    const points = new THREE.Points(nodeGeo, nodeMat);
    scene.add(points);

    const segPos = new Float32Array(MAX_SEG * 2 * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(segPos, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0x141414, transparent: true, opacity: 0.18 });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    const linkDist2 = LINK_DIST * LINK_DIST;
    let raf = 0;

    const step = () => {
      for (let i = 0; i < COUNT; i += 1) {
        const x = i * 3;
        const y = x + 1;
        const z = x + 2;
        positions[x] += velocities[x];
        positions[y] += velocities[y];
        positions[z] += velocities[z];
        if (positions[x] > BX || positions[x] < -BX) velocities[x] *= -1;
        if (positions[y] > BY || positions[y] < -BY) velocities[y] *= -1;
        if (positions[z] > BZ || positions[z] < -BZ) velocities[z] *= -1;
      }
      nodeGeo.attributes.position.needsUpdate = true;

      let seg = 0;
      for (let i = 0; i < COUNT; i += 1) {
        for (let j = i + 1; j < COUNT; j += 1) {
          const dx = positions[i * 3] - positions[j * 3];
          const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
          const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
          if (dx * dx + dy * dy + dz * dz < linkDist2 && seg < MAX_SEG) {
            const o = seg * 6;
            segPos[o] = positions[i * 3];
            segPos[o + 1] = positions[i * 3 + 1];
            segPos[o + 2] = positions[i * 3 + 2];
            segPos[o + 3] = positions[j * 3];
            segPos[o + 4] = positions[j * 3 + 1];
            segPos[o + 5] = positions[j * 3 + 2];
            seg += 1;
          }
        }
      }
      lineGeo.setDrawRange(0, seg * 2);
      lineGeo.attributes.position.needsUpdate = true;

      points.rotation.y += 0.0005;
      lines.rotation.y += 0.0005;

      renderer.render(scene, camera);
      raf = requestAnimationFrame(step);
    };

    if (prefersReduced) {
      renderer.render(scene, camera);
    } else {
      raf = requestAnimationFrame(step);
    }

    const onResize = () => {
      width = mount.clientWidth || 1;
      height = mount.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      nodeGeo.dispose();
      nodeMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}
