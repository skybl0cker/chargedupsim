// All field geometry in meters, in FIELD coordinates (WPILib convention):
//   origin = blue alliance wall / scoring-table corner, +x toward red, +y away from scoring table, +z up.
// Dimensions sourced from the 2023 FRC Game Manual & field drawings (via Team 6328 FieldConstants).
export const IN = 0.0254;

export const FIELD = {
  length: 651.25 * IN, // 16.54 m
  width: 315.5 * IN, // 8.01 m
  tapeWidth: 2 * IN,
  guardrailHeight: 20 * IN,
  allianceWallHeight: 78 * IN,
};

export const GRID = {
  outerX: 54.25 * IN, // front edge of grid (hybrid row front)
  lowX: (54.25 - 14.25 / 2) * IN,
  midX: (54.25 - 22.75) * IN,
  highX: (54.25 - 39.75) * IN,
  tagFaceX: 40.45 * IN, // front face of the mid shelf
  nodeY: Array.from({ length: 9 }, (_, i) => (20.19 + 22.0 * i) * IN),
  midConeZ: 34 * IN,
  highConeZ: 46 * IN,
  midCubeZ: 23.5 * IN, // shelf top
  highCubeZ: 35.5 * IN,
  poleDiameter: 1.66 * IN,
  leftY: (20.19 + 22 * 8 + 20.19) * IN, // 5.50 m (grid / community width)
  // node columns: 0..8 ; cone, cube, cone, ...  co-op grid = columns 3..5
  isCubeCol: (c) => c % 3 === 1,
  // structure (2023 manual §5.5), distances measured from the front face of the grid
  depth: 54.25 * IN,
  height: 46 * IN,
  hybridDepth: 16 * IN,
  dividerWidth: 3.5 * IN,
  dividerHeight: 5 * IN,
  cubeNodeWidth: 18.25 * IN,
  cubeNodeDepth: 17 * IN,
  midCubeFront: 14.25 * IN,
  highCubeFront: 31.625 * IN,
  cubeWall: 3 * IN,
  midConeFront: 22.75 * IN,
  highConeFront: 39.75 * IN,
  slope: Math.tan((35 * Math.PI) / 180),
  sections: [0, 75 * IN, 141 * IN, 216.38 * IN], // outer / co-op / outer grid assemblies (6ft3, 5ft6, 6ft3)
};

export const COMMUNITY = {
  midX: 132.375 * IN,
  outerX: 193.25 * IN,
  leftY: GRID.leftY,
  midY: GRID.leftY - 59.39 * IN + 2 * IN,
};

export const CHARGE_STATION = {
  innerX: GRID.outerX + 60.69 * IN,
  outerX: COMMUNITY.outerX - 2 * IN,
  rightY: 59.39 * IN,
  leftY: COMMUNITY.midY - 2 * IN,
  platformDepth: 48 * IN, // main pivoting surface (along x)
  platformWidth: 96 * IN,
  topHeight: 9.125 * IN, // top surface when level
  rampLength: 15.125 * IN,
  maxTilt: 15,
  levelTolerance: 2.5, // degrees for ENGAGED
};
CHARGE_STATION.centerX = (CHARGE_STATION.innerX + CHARGE_STATION.outerX) / 2;
CHARGE_STATION.centerY = (CHARGE_STATION.rightY + CHARGE_STATION.leftY) / 2;
CHARGE_STATION.depth = CHARGE_STATION.outerX - CHARGE_STATION.innerX;
CHARGE_STATION.width = CHARGE_STATION.leftY - CHARGE_STATION.rightY;

export const CABLE_BUMP = {
  centerX: CHARGE_STATION.centerX, // runs from the scoring-table guardrail to the center of the charge station
  width: 7 * IN,
  height: 0.875 * IN,
  length: 66 * IN,
};

// Loading zone that belongs to BLUE lives at the RED end of the field (mirror for red).
// Expressed here relative to the far wall: x measured as distance from the opposing alliance wall.
export const LOADING_ZONE = {
  width: 99 * IN,
  wideDepth: 132.25 * IN,
  narrowDepth: 264.25 * IN,
  midY: FIELD.width - 50.5 * IN,
  rightY: FIELD.width - 99 * IN,
  doubleSubstationDepth: 14 * IN,
  doubleSubstationShelfZ: 37.375 * IN,
  doubleSubstationCenterY: FIELD.width - 49.76 * IN,
  doubleSubstationWidth: 96 * IN,
  doubleSubstationHeight: 78 * IN,
  shelfWidth: 14 * IN,
  shelfDepth: 13 * IN,
  shelfOffset: 0.8, // sliding shelves pulled out toward the edges (from the substation center)
  singleSubstationLength: 105.625 * IN,
  singleSubstationDepth: 27 * IN,
  singleSubstationTall: 81.75 * IN,
  singleSubstationWidth: 22.75 * IN,
  singleSubstationFromWall: (14 + 88.77) * IN - (22.75 * IN) / 2, // center of the portal, from the far wall
  singleSubstationLowZ: 27.125 * IN,
  singleSubstationHeight: 18 * IN,
};

export const BARRIER = {
  y: GRID.leftY,
  length: 88 * IN,
  endX: COMMUNITY.midX,
  height: 12.25 * IN,
  thickness: 0.5 * IN,
  baseWidth: 16 * IN,
  baseHeight: 0.25 * IN,
};
BARRIER.startX = BARRIER.endX - BARRIER.length;

export const STAGING = {
  x: FIELD.length / 2 - 47.36 * IN,
  y: [0, 1, 2, 3].map((i) => (36.19 + 48 * i) * IN),
};

export const PIECES = {
  cone: { height: 12.8125 * IN, base: 8.375 * IN, baseThick: 1.0 * IN, mass: 0.652, topDia: 1.75 * IN, botDia: 6.5 * IN },
  cube: { size: 9.5 * IN, mass: 0.16 },
};

export const MATCH = {
  autoTime: 15,
  autoTeleopDelay: 3,
  teleopTime: 135,
  endgameTime: 30,
};

export const POINTS = {
  auto: { low: 3, mid: 4, high: 6 },
  teleop: { low: 2, mid: 3, high: 5 },
  supercharged: 3,
  link: 5,
  mobility: 3,
  autoDocked: 8,
  autoEngaged: 12,
  park: 2,
  docked: 6,
  engaged: 10,
  sustainabilityLinks: 5,
  sustainabilityLinksCoop: 4,
  activationPoints: 26,
  foul: 5,
  techFoul: 12,
};

export const ROBOT = {
  frame: 26 * IN, // square drivetrain frame
  bumper: 3.25 * IN, // bumper thickness per side
  mass: 56.7, // ~125 lb with bumpers + battery
  maxSpeed: 4.5, // m/s (MK4i L2-ish)
  maxAccel: 9.0, // m/s^2 (traction-limited)
  maxOmega: 9.5, // rad/s
  maxAlpha: 30, // rad/s^2
  bumperBottom: 0.5 * IN,
  bumperTop: 5.5 * IN,
  pivotHeight: 0.78,
  pivotBack: 0.12, // pivot is this far behind robot center
  armMin: 0.55,
  armMax: 1.7, // keeps intake within the 48in frame-extension limit
  armMaxDegPerSec: 200,
  extendSpeed: 2.4, // m/s
};
ROBOT.size = ROBOT.frame + ROBOT.bumper * 2;

// Physics collision groups (membership bits)
export const GROUP = { FIELD: 1, ROBOT: 2, PIECE: 4, CS: 8, CARPET: 16, NONE: 0 };
export const groups = (member, filter) => (member << 16) | filter;
