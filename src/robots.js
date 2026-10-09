import { IN } from './constants.js';
import { Arm6328 } from './mechanisms/mech6328.js';
import { Arm2910 } from './mechanisms/mech2910.js';

// Robot profiles: chassis + drivetrain numbers and the mechanism that goes on top.
export const ROBOTS = {
  2910: {
    id: '2910',
    name: '2910 Jack in the Bot — Phantom (2023)',
    team: 2910,
    frameX: 28 * IN, // 26x28 frame perimeter, long axis front-to-back
    frameY: 26 * IN,
    bumper: 3.25 * IN,
    bumperGap: 10 * IN, // front bumper is split around the claw opening
    bumperBottom: 1.0 * IN,
    bumperTop: 6.0 * IN,
    mass: 56, // ~90 lb robot + ballast, bumpers and battery
    maxSpeed: 4.9, // SDS MK4i L3 on Falcon 500s
    maxAccel: 9.0,
    maxOmega: 12.8, // max speed / drive base radius
    maxAlpha: 34,
    moduleX: (22.75 * IN) / 2, // WHEELBASE_METERS
    moduleY: (20.75 * IN) / 2, // TRACK_METERS
    bellyColor: 0x2a2c30,
    mechanism: (r) => new Arm2910(r),
  },
  dja: {
    id: 'dja',
    name: 'Double-jointed arm (9999)',
    team: 9999,
    frame: 25 * IN, // small square frame perimeter
    bumper: 3.25 * IN,
    bumperGap: 10 * IN, // front bumper is split around the claw opening
    bumperBottom: 1.0 * IN,
    bumperTop: 6.0 * IN,
    mass: 56,
    maxSpeed: 4.42, // SDS MK4i L2 + NEO: 14.5 ft/s
    maxAccel: 8.5,
    maxOmega: 12.4, // maxLinearSpeed / drive base radius
    maxAlpha: 32,
    moduleOffset: (19.75 * IN) / 2, // trackwidth 19.75 in
    bellyColor: 0x8a8f96,
    mechanism: (r) => new Arm6328(r),
  },
};
