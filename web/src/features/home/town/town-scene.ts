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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

import {
  DISTRICTS,
  journeyAt,
  type DistrictId,
  type JourneyStage,
  type TownController,
  type TownEvents,
} from './town-data'
import { createTownWorld } from './town-world'

export function createTownScene(
  host: HTMLElement,
  events: TownEvents
): TownController {
  const canvas = document.createElement('canvas')
  // Keep the final frame when motion is paused instead of continuously redrawing.
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  })
  if (!gl) throw new Error('WebGL2 unavailable')
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl,
    alpha: true,
    antialias: true,
  })
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.1, 100)
  const world = createTownWorld()
  const mobile = host.clientWidth < 700
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.3 : 1.65))
  renderer.setClearColor('#080b20', 0)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  canvas.setAttribute('aria-hidden', 'true')
  host.append(canvas)
  scene.add(world.root)
  const environment = new RoomEnvironment()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environmentTarget = pmrem.fromScene(environment, 0.04)
  scene.environment = environmentTarget.texture
  scene.environmentIntensity = 0.65
  environment.dispose()
  pmrem.dispose()
  scene.add(new THREE.HemisphereLight('#c7d5ff', '#423350', 0.9))
  const sun = new THREE.DirectionalLight('#eee5ff', 2)
  sun.position.set(-4, 12, 6)
  sun.castShadow = true
  sun.shadow.mapSize.set(mobile ? 512 : 1024, mobile ? 512 : 1024)
  Object.assign(sun.shadow.camera, {
    left: -12,
    right: 12,
    top: 12,
    bottom: -12,
    near: 0.1,
    far: 40,
  })
  sun.shadow.normalBias = 0.04
  scene.add(sun)
  const rim = new THREE.DirectionalLight('#b5a0ff', 1.6)
  rim.position.set(4, 4, -7)
  scene.add(rim)
  const peach = new THREE.PointLight('#ffcbaa', 9, 15)
  peach.position.set(4, 3, 5)
  scene.add(peach)

  camera.position.set(11, 17, 24)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0.25, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.065
  controls.enablePan = false
  controls.enabled = !mobile
  canvas.style.touchAction = 'pan-y'
  // Page scrolling belongs to the page; zoom has explicit accessible buttons.
  controls.enableZoom = false
  controls.minPolarAngle = 0.55
  controls.maxPolarAngle = 1.17
  controls.minAzimuthAngle = -0.65
  controls.maxAzimuthAngle = 1.4
  controls.update()
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.2, 0.55, 1.65)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reducedMotion = media.matches
  let paused = reducedMotion
  let disposed = false
  let contextLost = false
  let inView = true
  let frame = 0
  let previous = 0
  let elapsed = 0
  let needsRender = true
  let journeyTime: number | null = null
  let journeyDistrict: DistrictId = 'language'
  let lastStage: JourneyStage = 'idle'
  let focused: DistrictId | null = null
  let zoom = 1
  const focusTarget = new THREE.Vector3(0, 0.25, 0)
  const labelPoint = new THREE.Vector3()
  const tempPosition = new THREE.Vector3()
  const cameraShift = new THREE.Vector3()
  const originals = new Map<
    THREE.Object3D,
    { y: number; rotation: THREE.Euler; scale: THREE.Vector3 }
  >()
  for (const item of world.districts.values()) {
    for (const object of item.moving) {
      originals.set(object, {
        y: object.position.y,
        rotation: object.rotation.clone(),
        scale: object.scale.clone(),
      })
    }
  }
  const spark = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 16),
    new THREE.MeshStandardMaterial({
      color: '#fff4d6',
      emissive: '#fff1ce',
      emissiveIntensity: 4,
    })
  )
  spark.visible = false
  scene.add(spark)
  const trail = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({
      color: '#d2bbff',
      transparent: true,
      opacity: 0.8,
    }),
    16
  )
  trail.visible = false
  scene.add(trail)
  const trailDummy = new THREE.Object3D()
  const trailPositions = Array.from({ length: 16 }, () => new THREE.Vector3())

  const render = () => {
    if (disposed || contextLost) return
    composer.render()
    for (const district of DISTRICTS) {
      labelPoint
        .set(district.position[0], district.position[1], district.position[2])
        .add(new THREE.Vector3(0, -0.45, district.radius * 0.65))
      labelPoint.project(camera)
      events.project(
        district.id,
        (labelPoint.x * 0.5 + 0.5) * host.clientWidth,
        (-labelPoint.y * 0.5 + 0.5) * host.clientHeight,
        Math.abs(labelPoint.x) < 0.95 && Math.abs(labelPoint.y) < 0.92
      )
    }
    needsRender = false
  }
  const resize = () => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (!width || !height) return
    const aspect = width / height
    controls.enabled = width >= 700
    // Fit the entire archipelago on narrow screens; never crop interactive zones.
    const halfHeight = Math.max(5.7, 9.5 / aspect)
    camera.left = -halfHeight * aspect
    camera.right = halfHeight * aspect
    camera.top = halfHeight
    camera.bottom = -halfHeight
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    composer.setSize(width, height)
    // Resizing clears the drawing buffer. Restore it in this layout cycle,
    // including when animation is paused and no following frame is pending.
    render()
    schedule()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)
  resize()
  const observer = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
    previous = 0
    if (inView) schedule()
  })
  observer.observe(host)

  function schedule() {
    if (
      !frame &&
      !disposed &&
      !contextLost &&
      (inView || journeyTime !== null) &&
      !document.hidden
    ) {
      frame = requestAnimationFrame(animate)
    }
  }

  function animate(now: number) {
    frame = 0
    if (
      disposed ||
      contextLost ||
      (!inView && journeyTime === null) ||
      document.hidden
    ) {
      return
    }
    const realDelta = previous ? (now - previous) / 1000 : 0
    const delta = Math.min(realDelta, 0.05)
    previous = now
    if (!paused) {
      elapsed += delta
      world.aurora.uniforms.time.value = elapsed
      world.particles.rotation.y = elapsed * 0.008
      for (const [index, district] of DISTRICTS.entries()) {
        const sculpture = world.districts.get(district.id)
        if (!sculpture) continue
        sculpture.root.position.y =
          district.position[1] + Math.sin(elapsed * 0.55 + index * 1.4) * 0.09
        for (const [i, object] of sculpture.moving.entries()) {
          const original = originals.get(object)
          if (!original) continue
          object.position.y =
            original.y + Math.sin(elapsed * 0.7 + i * 1.6) * 0.055
          object.rotation.y =
            original.rotation.y + elapsed * (i % 2 ? -0.08 : 0.07)
        }
      }
      needsRender = true
    }
    const targetDistance = controls.target.distanceTo(focusTarget)
    const desiredZoom = (focused ? 1.28 : 1) * zoom
    if (targetDistance > 0.002 || Math.abs(camera.zoom - desiredZoom) > 0.002) {
      const amount = reducedMotion ? 1 : 1 - Math.exp(-delta * 5)
      cameraShift.copy(focusTarget).sub(controls.target).multiplyScalar(amount)
      camera.position.add(cameraShift)
      controls.target.add(cameraShift)
      camera.zoom = THREE.MathUtils.lerp(camera.zoom, desiredZoom, amount)
      camera.updateProjectionMatrix()
      needsRender = true
    }
    controls.update()
    if (journeyTime !== null && (!paused || reducedMotion)) {
      journeyTime += realDelta
      const { stage, progress } = journeyAt(journeyTime)
      if (stage !== lastStage) {
        lastStage = stage
        events.stage(stage)
      }
      const memory = world.districts.get('memory')
      const destination = world.districts.get(journeyDistrict)
      const core = world.districts.get('core')
      if (memory && destination && core) {
        const memoryPath = world.paths[3]
        const destinationIndex =
          DISTRICTS.findIndex((district) => district.id === journeyDistrict) - 1
        const modelPath = world.paths[destinationIndex]
        if (progress < 0.24) {
          memoryPath.getPoint(progress / 0.24, tempPosition)
        } else if (progress < 0.46) {
          memoryPath.getPoint(1 - (progress - 0.24) / 0.22, tempPosition)
        } else if (progress < 0.75) {
          modelPath.getPoint((progress - 0.46) / 0.29, tempPosition)
        } else {
          modelPath.getPoint(1 - (progress - 0.75) / 0.25, tempPosition)
        }
        tempPosition.y += 0.16
        spark.position.copy(tempPosition)
        spark.visible = !reducedMotion && stage !== 'complete'
        trail.visible = spark.visible
        trailPositions.unshift(tempPosition.clone())
        trailPositions.pop()
        for (const [i, point] of trailPositions.entries()) {
          trailDummy.position.copy(point)
          trailDummy.scale.setScalar(1 - i / 16)
          trailDummy.updateMatrix()
          trail.setMatrixAt(i, trailDummy.matrix)
        }
        trail.instanceMatrix.needsUpdate = true
        const pulse = reducedMotion
          ? 1
          : 1 + Math.sin(progress * Math.PI * 12) * 0.13
        destination.beacon.scale.setScalar(pulse)
        if (stage === 'complete') {
          journeyTime = null
          destination.beacon.scale.copy(
            originals.get(destination.beacon)?.scale ??
              new THREE.Vector3(1, 1, 1)
          )
        }
      }
      needsRender = true
    }
    if (needsRender && inView) render()
    if (
      !paused ||
      (journeyTime !== null && (!paused || reducedMotion)) ||
      targetDistance > 0.002 ||
      Math.abs(camera.zoom - desiredZoom) > 0.002
    ) {
      schedule()
    }
  }
  const onControlsChange = () => {
    needsRender = true
    schedule()
  }
  controls.addEventListener('change', onControlsChange)
  const onVisibility = () => {
    previous = 0
    schedule()
  }
  document.addEventListener('visibilitychange', onVisibility)
  const onMotion = () => {
    reducedMotion = media.matches
    paused = reducedMotion
    previous = 0
    needsRender = true
    schedule()
  }
  media.addEventListener('change', onMotion)
  const onLost = (event: Event) => {
    event.preventDefault()
    contextLost = true
    cancelAnimationFrame(frame)
    frame = 0
    events.failed()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pointerDown = { x: 0, y: 0 }
  const onPointerDown = (event: PointerEvent) => {
    pointerDown = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (
      Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) >
      6
    ) {
      return
    }
    const rect = canvas.getBoundingClientRect()
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1
    )
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(
      [...world.districts.values()].map((item) => item.root),
      true
    )[0]
    let object: THREE.Object3D | null = hit?.object ?? null
    while (object) {
      if (object.userData.district) {
        events.select(object.userData.district as DistrictId)
        break
      }
      object = object.parent
    }
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  render()
  schedule()
  return {
    focus(district) {
      focused = district === 'core' ? null : district
      if (!focused) {
        zoom = 1
        camera.position.set(11, 17, 24)
        controls.target.set(0, 0.25, 0)
      }
      focusTarget.set(0, 0.25, 0)
      if (focused) {
        const definition = DISTRICTS.find((item) => item.id === focused)
        if (definition) {
          focusTarget
            .set(
              definition.position[0],
              definition.position[1],
              definition.position[2]
            )
            .multiplyScalar(0.55)
            .add(new THREE.Vector3(0, 0.4, 0))
        }
      }
      needsRender = true
      schedule()
    },
    pause(value) {
      paused = value
      previous = 0
      needsRender = true
      schedule()
    },
    journey(district) {
      journeyDistrict =
        district === 'core' || district === 'memory' ? 'language' : district
      journeyTime = 0
      lastStage = 'routing'
      events.stage('routing')
      const origin = new THREE.Vector3(0, 2.6, 0)
      for (const point of trailPositions) point.copy(origin)
      previous = 0
      schedule()
    },
    zoom(direction) {
      zoom = THREE.MathUtils.clamp(zoom + direction * 0.15, 0.8, 1.45)
      needsRender = true
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      media.removeEventListener('change', onMotion)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      controls.removeEventListener('change', onControlsChange)
      controls.dispose()
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      scene.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose()
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments
        ) {
          geometries.add(object.geometry)
          const list = Array.isArray(object.material)
            ? object.material
            : [object.material]
          for (const material of list) materials.add(material)
        }
      })
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      sun.shadow.dispose()
      environmentTarget.dispose()
      for (const pass of composer.passes) pass.dispose()
      composer.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
