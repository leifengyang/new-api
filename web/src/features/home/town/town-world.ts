/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import * as THREE from 'three'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { DISTRICTS, type DistrictId } from './town-data'

export interface TownSculpture {
  root: THREE.Group
  moving: THREE.Object3D[]
  beacon: THREE.Mesh
}

export interface TownWorld {
  root: THREE.Group
  districts: Map<DistrictId, TownSculpture>
  paths: THREE.CatmullRomCurve3[]
  particles: THREE.InstancedMesh
  aurora: THREE.ShaderMaterial
}

function surface(color: string, metalness = 0.3, roughness = 0.35) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}

function lightMaterial(color: string, intensity = 0.8) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    metalness: 0.15,
    roughness: 0.3,
  })
}

function place(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0]
) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...position)
  mesh.castShadow = !(
    material instanceof THREE.MeshStandardMaterial &&
    material.emissiveIntensity > 0 &&
    material.emissive.getHex() !== 0
  )
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

/** Batch stationary details per island while preserving district picking. */
function batchIslandGeometry(root: THREE.Group, moving: THREE.Object3D[]) {
  const groups = new Map<
    string,
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[]
  >()
  for (const object of root.children) {
    if (
      !(object instanceof THREE.Mesh) ||
      object instanceof THREE.InstancedMesh ||
      moving.includes(object)
    ) {
      continue
    }
    if (
      !(object.material instanceof THREE.MeshStandardMaterial) ||
      object.material instanceof THREE.MeshPhysicalMaterial
    ) {
      continue
    }
    if (object.children.length || !object.geometry.hasAttribute('uv')) continue
    const material = object.material
    const key = [
      material.color.getHex(),
      material.emissive.getHex(),
      material.emissiveIntensity,
      material.roughness,
      material.metalness,
      material.side,
      object.castShadow,
    ].join('/')
    const meshes = groups.get(key) ?? []
    meshes.push(
      object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    )
    groups.set(key, meshes)
  }
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue
    const transformed = meshes.map((mesh) => {
      mesh.updateMatrix()
      const geometry = mesh.geometry.index
        ? mesh.geometry.toNonIndexed()
        : mesh.geometry.clone()
      return geometry.applyMatrix4(mesh.matrix)
    })
    const merged = mergeGeometries(transformed)
    for (const geometry of transformed) geometry.dispose()
    if (!merged) continue
    const combined = new THREE.Mesh(merged, meshes[0].material)
    combined.castShadow = meshes[0].castShadow
    combined.receiveShadow = true
    root.add(combined)
    for (const mesh of meshes) {
      root.remove(mesh)
      mesh.geometry.dispose()
      if (mesh.material !== combined.material) mesh.material.dispose()
    }
  }
}

function ring(
  parent: THREE.Object3D,
  radius: number,
  color: string,
  y: number,
  thickness = 0.025
) {
  const mesh = place(
    parent,
    new THREE.TorusGeometry(radius, thickness, 8, 80),
    lightMaterial(color),
    [0, y, 0]
  )
  mesh.rotation.x = Math.PI / 2
  return mesh
}

/** Original SVG profiles become beveled, tangible objects in the scene. */
function glyphGeometry(path: string, depth: number) {
  const svg = new SVGLoader().parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><path d="${path}" /></svg>`
  )
  const shapes = svg.paths.flatMap((item) => item.toShapes())
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    curveSegments: 16,
  })
  geometry.center()
  return geometry
}

function floatingIsland(radius: number, color: string, seed: number) {
  const island = new THREE.Group()
  // Irregular concentric rings make a cut gemstone underside, not a cylinder.
  const segments = 12
  const vertices: number[] = []
  const levels = [
    { y: -0.1, r: radius },
    { y: -0.55, r: radius * 0.92 },
    { y: -1.5, r: radius * 0.53 },
    { y: -1.95, r: radius * 0.12 },
  ]
  for (let level = 0; level < levels.length - 1; level++) {
    for (let i = 0; i < segments; i++) {
      const points: THREE.Vector3[] = []
      for (const [step, offset] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]) {
        const row = levels[level + step]
        const angle = ((i + offset) / segments) * Math.PI * 2
        const jitter = 1 + Math.sin((i + offset) * 8.4 + seed) * 0.08
        points.push(
          new THREE.Vector3(
            Math.cos(angle) * row.r * jitter,
            row.y + Math.sin((i + offset) * 2.3 + seed) * 0.1,
            Math.sin(angle) * row.r * jitter
          )
        )
      }
      for (const index of [0, 2, 1, 1, 2, 3]) {
        vertices.push(...points[index].toArray())
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geo.computeVertexNormals()
  const rock = new THREE.MeshStandardMaterial({
    color: '#4d4276',
    roughness: 0.68,
    metalness: 0.18,
    flatShading: true,
    side: THREE.DoubleSide,
  })
  place(island, geo, rock)
  place(
    island,
    new THREE.CylinderGeometry(radius, radius * 1.015, 0.16, 12),
    surface('#8b8aa8', 0.32, 0.5),
    [0, -0.08, 0]
  )
  place(
    island,
    new THREE.CylinderGeometry(radius * 0.87, radius * 0.9, 0.09, 64),
    surface('#3d4265', 0.5),
    [0, 0.035, 0]
  )
  ring(island, radius * 0.87, color, 0.09, 0.014)
  ring(island, radius * 0.97, '#a8a5d3', 0.015, 0.012)
  // Tiny gold inlays and crystal growths give each island a miniature scale.
  const postGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.22, 5)
  const postMaterial = surface('#dac59e', 0.65)
  const crystalGeometry = new THREE.ConeGeometry(0.11, 0.43, 5)
  const crystalMaterial = surface(color, 0.4, 0.2)
  const crystals = new THREE.InstancedMesh(crystalGeometry, crystalMaterial, 28)
  const dummy = new THREE.Object3D()
  for (let i = 0; i < 28; i++) {
    const angle = (i / 28) * Math.PI * 2
    const distance = radius * (0.7 + Math.sin(i * 7.3) * 0.06)
    dummy.position.set(
      Math.cos(angle) * distance,
      0.17,
      Math.sin(angle) * distance
    )
    dummy.rotation.set(Math.sin(i) * 0.25, i, Math.cos(i) * 0.25)
    dummy.scale.setScalar(0.45 + (Math.sin(i * 4.7 + seed) + 1) * 0.4)
    dummy.updateMatrix()
    crystals.setMatrixAt(i, dummy.matrix)
    if (i % 2 === 0) {
      place(island, postGeometry, postMaterial, [
        Math.cos(angle) * radius * 0.95,
        0.16,
        Math.sin(angle) * radius * 0.95,
      ])
    }
  }
  crystals.castShadow = true
  island.add(crystals)
  const bottom = place(
    island,
    new THREE.OctahedronGeometry(0.16),
    lightMaterial(color, 2),
    [0, -1.82, 0]
  )
  bottom.scale.y = 2
  return island
}

function createCore(root: THREE.Group, moving: THREE.Object3D[]) {
  const porcelain = surface('#d5cbed', 0.45, 0.23)
  const gold = surface('#d8b693', 0.7, 0.2)
  for (let i = 0; i < 3; i++) {
    place(
      root,
      new THREE.CylinderGeometry(1.25 - i * 0.19, 1.35 - i * 0.19, 0.14, 8),
      i === 1 ? gold : porcelain,
      [0, 0.16 + i * 0.15, 0]
    )
  }
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#b3a4fb',
    metalness: 0.12,
    roughness: 0.13,
    transmission: 0.5,
    thickness: 1.4,
    ior: 1.35,
    iridescence: 0.7,
    iridescenceIOR: 1.3,
    clearcoat: 1,
    emissive: '#7461ba',
    emissiveIntensity: 0.16,
  })
  const heart = place(
    root,
    new THREE.IcosahedronGeometry(0.8, 0),
    glass,
    [0, 2, 0]
  )
  const heartEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(heart.geometry),
    new THREE.LineBasicMaterial({
      color: '#e5c8ff',
      transparent: true,
      opacity: 0.65,
    })
  )
  heart.add(heartEdges)
  place(heart, new THREE.OctahedronGeometry(0.29), lightMaterial('#ead9ff', 3))
  moving.push(heart)
  const arch = glyphGeometry(
    'M-.85 0 Q-1 2.1 0 3 Q1 2.1 .85 0 L.66 0 Q.72 1.9 0 2.63 Q-.72 1.9-.66 0Z',
    0.1
  )
  for (let i = 0; i < 4; i++) {
    const petal = place(root, arch, i % 2 ? gold : porcelain, [0, 1.7, 0])
    petal.rotation.y = (i * Math.PI) / 2 + Math.PI / 4
    petal.scale.set(0.9, 1, 1)
  }
  for (let i = 0; i < 3; i++) {
    const orbit = new THREE.Group()
    orbit.position.y = 2
    orbit.rotation.set(0.45 + i * 0.8, 0.5 + i, 0.3)
    const halo = place(
      orbit,
      new THREE.TorusGeometry(1.16 + i * 0.2, 0.019, 8, 100),
      i === 1 ? gold : lightMaterial('#c2b1ff', 1.3)
    )
    place(
      halo,
      new THREE.SphereGeometry(0.07, 12, 12),
      lightMaterial('#fce1bd', 2),
      [1.16 + i * 0.2, 0, 0]
    )
    root.add(orbit)
    moving.push(orbit)
  }
  ring(root, 1.55, '#b6a2ed', 0.18, 0.02)
  // A crown of floating, original four-point SVG stars.
  const starGeo = glyphGeometry(
    'M0 .3 Q.04 .04 .3 0 Q.04-.04 0-.3 Q-.04-.04-.3 0 Q-.04 .04 0 .3Z',
    0.04
  )
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    const star = place(root, starGeo, gold, [
      Math.cos(angle) * 1.9,
      1.0 + (i % 2) * 0.6,
      Math.sin(angle) * 1.9,
    ])
    star.rotation.y = -angle
    moving.push(star)
  }
  return heart
}

function createLanguage(root: THREE.Group, moving: THREE.Object3D[]) {
  const teal = surface('#a5e5d3', 0.35, 0.24)
  const gold = surface('#d1c6a5', 0.7, 0.2)
  const leafGeometry = glyphGeometry(
    'M0 0 Q-1.05 .7 0 1.75 Q1.05 .7 0 0Z',
    0.12
  )
  const stem = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, 0),
    new THREE.Vector3(-0.2, 1, 0.1),
    new THREE.Vector3(0, 2.1, 0),
  ])
  place(root, new THREE.TubeGeometry(stem, 24, 0.09, 8, false), gold)
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3
    const leaf = place(root, leafGeometry, teal, [
      Math.cos(angle) * 0.5,
      1.35 + (i % 2) * 0.5,
      Math.sin(angle) * 0.5,
    ])
    leaf.rotation.set(0.4, -angle, i % 2 ? 0.45 : -0.45)
    leaf.scale.setScalar(0.8)
    moving.push(leaf)
  }
  const beacon = place(
    root,
    new THREE.OctahedronGeometry(0.26),
    lightMaterial('#bcffe6', 2),
    [0, 2.45, 0]
  )
  moving.push(beacon)
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 0.4
    const module = new THREE.Group()
    module.position.set(Math.cos(angle) * 1.1, 0.35, Math.sin(angle) * 1.1)
    module.rotation.y = -angle
    place(
      module,
      new THREE.BoxGeometry(0.53, 0.7, 0.1),
      surface('#526f75', 0.45)
    )
    for (let line = 0; line < 3; line++) {
      place(
        module,
        new THREE.BoxGeometry(0.25 - (line % 2) * 0.08, 0.018, 0.015),
        lightMaterial('#a1e6d0', 1.5),
        [-0.04, 0.17 - line * 0.14, 0.06]
      )
    }
    root.add(module)
  }
  ring(root, 1.3, '#7ae0c4', 0.15)
  return beacon
}

function createVision(root: THREE.Group, moving: THREE.Object3D[]) {
  const purple = surface('#a7a0d9', 0.5, 0.22)
  const pink = lightMaterial('#ffb5d4', 1.2)
  const frame = glyphGeometry(
    'M0 2.5 1.28 .05-1.28 .05Z M0 2.08-.96 .24 .96 .24Z',
    0.16
  )
  const sculpture = new THREE.Group()
  sculpture.position.y = 1.55
  for (let i = 0; i < 3; i++) {
    const triangle = place(sculpture, frame, i === 1 ? pink : purple)
    triangle.rotation.y = (i * Math.PI) / 3
  }
  root.add(sculpture)
  moving.push(sculpture)
  const prism = place(
    root,
    new THREE.OctahedronGeometry(0.45),
    new THREE.MeshPhysicalMaterial({
      color: '#ffaed5',
      metalness: 0.15,
      roughness: 0.16,
      clearcoat: 1,
      iridescence: 1,
      emissive: '#d24f98',
      emissiveIntensity: 0.3,
    }),
    [0, 1.6, 0]
  )
  moving.push(prism)
  const colors = ['#b6b1ff', '#ffa3c4', '#ffd7b0', '#9ee5d5']
  for (let i = 0; i < 7; i++) {
    const tile = place(
      root,
      new THREE.BoxGeometry(0.43, 0.09, 0.65),
      surface(colors[i % colors.length], 0.5, 0.18),
      [-1 + i * 0.31, 0.23 + Math.sin(i * 0.9) * 0.1, 1]
    )
    tile.rotation.y = -0.4
  }
  ring(root, 1.35, '#e4a7d9', 0.15)
  return prism
}

function createAudio(root: THREE.Group, moving: THREE.Object3D[]) {
  const gold = surface('#e1bb86', 0.6, 0.22)
  const cream = surface('#f3dcb7', 0.35, 0.26)
  const wave = new THREE.Group()
  wave.position.y = 0.23
  for (let i = 0; i < 13; i++) {
    const angle = (i / 13) * Math.PI * 2
    const height = 0.5 + (Math.sin(i * 1.5) + 1) * 0.55
    place(
      wave,
      new THREE.CylinderGeometry(0.07, 0.07, height, 10),
      i % 3 ? cream : gold,
      [Math.cos(angle) * 0.85, height / 2, Math.sin(angle) * 0.85]
    )
    place(
      wave,
      new THREE.SphereGeometry(0.075, 10, 10),
      lightMaterial('#ffe3ab', 1.3),
      [Math.cos(angle) * 0.85, height, Math.sin(angle) * 0.85]
    )
  }
  root.add(wave)
  moving.push(wave)
  const orb = place(
    root,
    new THREE.SphereGeometry(0.3, 24, 24),
    gold,
    [0, 1.35, 0]
  )
  moving.push(orb)
  for (let i = 0; i < 3; i++) {
    const halo = ring(root, 0.4 + i * 0.25, '#edcb93', 1.35)
    halo.rotation.set(Math.PI / 2 + i * 0.3, i * 0.25, 0)
    moving.push(halo)
  }
  return orb
}

function createMemory(root: THREE.Group, moving: THREE.Object3D[]) {
  const blue = surface('#a9c3ed', 0.6, 0.21)
  const light = lightMaterial('#aacbff', 1.5)
  for (let i = 0; i < 5; i++) {
    const sheet = place(
      root,
      new THREE.BoxGeometry(1.35 - i * 0.08, 0.085, 1.35 - i * 0.08),
      i % 2 ? blue : surface('#7c87c1', 0.45),
      [0, 0.35 + i * 0.33, 0]
    )
    sheet.rotation.y = Math.PI / 4 + i * 0.19
    moving.push(sheet)
    for (let j = 0; j < 4; j++) {
      const angle = (j * Math.PI) / 2
      place(sheet, new THREE.SphereGeometry(0.04, 8, 8), light, [
        Math.cos(angle) * 0.55,
        0.055,
        Math.sin(angle) * 0.55,
      ])
    }
  }
  const orb = place(
    root,
    new THREE.OctahedronGeometry(0.24),
    light,
    [0, 2.15, 0]
  )
  moving.push(orb)
  ring(root, 1.05, '#9fbef7', 0.15)
  return orb
}

export function createTownWorld(): TownWorld {
  const root = new THREE.Group()
  const districts = new Map<DistrictId, TownSculpture>()
  const builders = {
    core: createCore,
    language: createLanguage,
    vision: createVision,
    audio: createAudio,
    memory: createMemory,
  }
  for (const [index, district] of DISTRICTS.entries()) {
    const island = floatingIsland(district.radius, district.color, index * 3.1)
    island.position.set(
      district.position[0],
      district.position[1],
      district.position[2]
    )
    island.userData.district = district.id
    const moving: THREE.Object3D[] = []
    const beacon = builders[district.id](island, moving)
    batchIslandGeometry(island, moving)
    root.add(island)
    districts.set(district.id, { root: island, moving, beacon })
  }
  const paths: THREE.CatmullRomCurve3[] = []
  const core = new THREE.Vector3(0, 0.95, 0)
  for (const district of DISTRICTS.slice(1)) {
    const end = new THREE.Vector3(...district.position).add(
      new THREE.Vector3(0, 0.3, 0)
    )
    const middle = core.clone().lerp(end, 0.5)
    middle.y -= 0.38
    const curve = new THREE.CatmullRomCurve3([core, middle, end])
    paths.push(curve)
    const pathLight = lightMaterial(district.color, 1.2)
    place(
      root,
      new THREE.TubeGeometry(curve, 48, 0.047, 7, false),
      surface('#555279', 0.55)
    )
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, 0.013, 5, false),
      pathLight
    )
    rail.position.y = 0.08
    root.add(rail)
    for (let i = 1; i < 12; i++) {
      const dot = curve.getPoint(i / 12)
      place(root, new THREE.SphereGeometry(0.026, 7, 7), pathLight, [
        dot.x,
        dot.y + 0.08,
        dot.z,
      ])
    }
  }
  // Satellite tensors and drifting crystal shards enrich the silhouette.
  const shardGeometry = new THREE.OctahedronGeometry(1, 0)
  const shardMaterial = surface('#9184bd', 0.48)
  const shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, 55)
  const dummy = new THREE.Object3D()
  for (let i = 0; i < 55; i++) {
    const angle = i * 2.399
    const r = 7 + Math.sin(i * 8.1) * 2
    dummy.position.set(
      Math.cos(angle) * r,
      -1.9 + Math.sin(i * 2.7) * 0.7,
      Math.sin(angle) * r * 0.78
    )
    dummy.rotation.set(i, i * 0.7, i * 0.2)
    const s = 0.06 + (Math.sin(i * 6.1) + 1) * 0.14
    dummy.scale.set(s, s * 1.8, s)
    dummy.updateMatrix()
    shards.setMatrixAt(i, dummy.matrix)
  }
  root.add(shards)
  const particles = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.022, 6, 6),
    lightMaterial('#c7b8ff', 2.3),
    95
  )
  for (let i = 0; i < 95; i++) {
    dummy.position.set(
      Math.sin(i * 73.1) * 11,
      0.5 + Math.cos(i * 13.4) * 3,
      Math.cos(i * 21.7) * 8
    )
    dummy.scale.setScalar(0.5 + (i % 4) * 0.35)
    dummy.updateMatrix()
    particles.setMatrixAt(i, dummy.matrix)
  }
  root.add(particles)
  const aurora = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { time: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      uniform float time;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.z += sin(p.x * .22 + time * .12) * 1.6;
        p.y += sin(p.x * .15 + time * .1) * 1.2;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float time;
      void main() {
        float wave = sin(vUv.x * 8. + time * .13) * .12 + .5;
        float ribbon = exp(-pow((vUv.y - wave) * 8., 2.));
        float detail = .6 + .4 * sin(vUv.x * 180. + time * .15);
        float edge = smoothstep(0., .18, vUv.x) * (1. - smoothstep(.75, 1., vUv.x));
        vec3 color = mix(vec3(.28,.19,.65), vec3(.18,.69,.61), vUv.x);
        gl_FragColor = vec4(color, ribbon * edge * (.11 + detail * .065));
      }`,
  })
  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 15, 64, 12),
    aurora
  )
  curtain.position.set(0, 4, -13)
  root.add(curtain)
  batchIslandGeometry(root, [])
  return { root, districts, paths, particles, aurora }
}
