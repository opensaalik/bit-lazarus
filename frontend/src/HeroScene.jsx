import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function HeroScene() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;

    if (!mount) {
      return undefined;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 0.4, 6.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const torus = new THREE.Mesh(
      new THREE.TorusKnotGeometry(1.5, 0.42, 220, 24),
      new THREE.MeshPhysicalMaterial({
        color: "#ff7a32",
        emissive: "#072d3c",
        emissiveIntensity: 0.5,
        metalness: 0.1,
        roughness: 0.26,
        transparent: true,
        opacity: 0.92,
        clearcoat: 1,
      }),
    );
    group.add(torus);

    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.8, 3),
      new THREE.MeshBasicMaterial({
        color: "#2bd1c8",
        wireframe: true,
        transparent: true,
        opacity: 0.12,
      }),
    );
    group.add(shell);

    const particleGeometry = new THREE.BufferGeometry();
    const particleCount = 240;
    const positions = new Float32Array(particleCount * 3);

    for (let index = 0; index < particleCount; index += 1) {
      const radius = 4 + Math.random() * 3.2;
      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.5) * 4;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = elevation;
      positions[index * 3 + 2] = Math.sin(angle) * radius;
    }

    particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        color: "#ffd27d",
        size: 0.05,
        transparent: true,
        opacity: 0.8,
      }),
    );
    scene.add(particles);

    const glow = new THREE.PointLight("#ff9b4f", 28, 18, 2);
    glow.position.set(2, 2, 4);
    scene.add(glow);

    const fill = new THREE.PointLight("#32ffd4", 12, 14, 2);
    fill.position.set(-3, -1, 3);
    scene.add(fill);

    const clock = new THREE.Clock();
    let frameId = 0;

    const animate = () => {
      const elapsed = clock.getElapsedTime();
      group.rotation.x = elapsed * 0.18;
      group.rotation.y = elapsed * 0.24;
      shell.rotation.x = -elapsed * 0.09;
      shell.rotation.z = elapsed * 0.07;
      torus.position.y = Math.sin(elapsed * 0.7) * 0.16;
      particles.rotation.y = elapsed * 0.03;
      particles.rotation.x = Math.sin(elapsed * 0.15) * 0.08;
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    animate();

    const handleResize = () => {
      if (!mount) {
        return;
      }

      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      mount.removeChild(renderer.domElement);
      particleGeometry.dispose();
      renderer.dispose();
      torus.geometry.dispose();
      torus.material.dispose();
      shell.geometry.dispose();
      shell.material.dispose();
      particles.material.dispose();
    };
  }, []);

  return <div aria-hidden="true" className="hero-scene" ref={mountRef} />;
}
