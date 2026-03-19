import {LogicVector2} from "../../gene/battle/LogicVector2";
import {ProjectileData} from "../../gene/battle/ProjectileData";
import {UsefulInfo} from "../../gene/features/UsefulInfo";
import {Libg} from "../../libs/Libg";
import {LogicMath} from "../../titan/logic/math/LogicMath";
import {LogicProjectileData} from "../data/LogicProjectileData";
import {BattleMode} from "./BattleMode";
import {ClientInput, ClientInputType} from "./ClientInput";
import {ClientInputManager} from "./ClientInputManager";
import {LogicTileMap} from "./level/LogicTileMap";
import {LogicPlayer} from "./LogicPlayer";
import {LogicCharacterClientOwn} from "./objects/LogicCharacterClientOwn";
import {LogicGameObjectManagerClient} from "./objects/LogicGameObjectManagerClient";
import {LogicProjectileClient} from "./objects/LogicProjectileClient";
import {Configuration} from "../../gene/Configuration";
import {LogicGameObjectClient} from "./objects/LogicGameObjectClient";

const LogicBattleModeClient_getOwnCharacter = new NativeFunction( // "spray_def_atk" (not sure)
    Libg.offset(0x9C4330, 0x4B7480), 'pointer', ['pointer']
);

const LogicBattleModeClient_update = new NativeFunction( // TODO
    Libg.offset(0x0, 0x4B5EA4), 'void', ['pointer', 'float', 'float']
);

const LogicBattleModeClient_ownPlayerIndexOffset = 224;
const LogicBattleModeClient_ownPlayerTeamOffset = 228;
const LogicBattleModeClient_tileMapOffset = 248;
const LogicBattleModeClient_currentBattleStateOffset = 284;
export const LogicBattleModeClient_gameModeVariationOffset = 292;
export const LogicBattleModeClient_underdogOffset = 334;

export class LogicBattleModeClient {
    static self: LogicBattleModeClient;

    private instance: NativePointer;
    private bulletXY: number[][] = [];
    private tileMap: LogicTileMap;
    private ticksGone: number = 0;
    private dodgeTick: number = 0;
    private projectileGameObjectManager: LogicGameObjectManagerClient;

    constructor(instance: NativePointer) {
        this.instance = instance;
        this.bulletXY = [];

        this.tileMap = new LogicTileMap(
            instance.add(LogicBattleModeClient_tileMapOffset).readPointer()
        );

        this.projectileGameObjectManager = new LogicGameObjectManagerClient(
            this.instance.add(40).readPointer() // todo check other values like 48 or 56
        );

        LogicBattleModeClient.self = this;
    }

    tick() {
        this.ticksGone = this.instance.add(72).readInt();

        UsefulInfo.ticks = this.ticksGone;

        if (this.isGameOver()) {
            return;
        }

        // AUTO DODGE
        if (Configuration.autoDodge) {
            this.tickAutoDodge();
        }
    }

    private tickAutoDodge(): void {
        try {
            // Throttle: run every 2 ticks
            this.dodgeTick++;
            if (this.dodgeTick % 2 !== 0) return;

            const ownCharacter = LogicBattleModeClient.getOwnCharacter(this.instance);
            if (ownCharacter.isNull()) return;

            const ownX = LogicGameObjectClient.getX(ownCharacter);
            const ownY = LogicGameObjectClient.getY(ownCharacter);
            const ownTeam = ownCharacter.add(64).readInt(); // teamIndexOffset

            const projObjects = this.projectileGameObjectManager.getGameObjects();

            // Find the closest threatening projectile
            let closestThreat: LogicProjectileClient | null = null;
            let closestDistSq = Number.MAX_VALUE;

            for (const obj of projObjects) {
                if (!(obj instanceof LogicProjectileClient)) continue;

                const proj = obj as LogicProjectileClient;
                if (proj.getTeamIndex() === ownTeam) continue;

                const data = proj.getData();
                if (!data.canBeEscaped()) continue;

                // Scale danger threshold based on projectile speed.
                // dangerThresholdSq = 700 * speed gives danger radius sqrt(700*speed),
                // which equals 700 at speed=700 and grows proportionally for faster projectiles.
                const speed = data.getSpeed();
                const dangerThresholdSq = 700 * Math.max(300, speed);

                const projX = proj.getX();
                const projY = proj.getY();

                const dx = projX - ownX;
                const dy = projY - ownY;
                const distSq = dx * dx + dy * dy;

                if (distSq < dangerThresholdSq && distSq < closestDistSq) {
                    closestDistSq = distSq;
                    closestThreat = proj;
                }
            }

            if (!closestThreat) return;

            // Check BOTH perpendicular directions and pick the one further from enemy projectiles
            const projAngle = closestThreat.getAngle();
            const angleRad1 = (projAngle + 90) * Math.PI / 180;
            const angleRad2 = (projAngle - 90) * Math.PI / 180;

            const dodgeX1 = Math.round(ownX + Math.cos(angleRad1) * 900);
            const dodgeY1 = Math.round(ownY + Math.sin(angleRad1) * 900);
            const dodgeX2 = Math.round(ownX + Math.cos(angleRad2) * 900);
            const dodgeY2 = Math.round(ownY + Math.sin(angleRad2) * 900);

            // Score each direction by how many projectiles are nearby
            let score1 = 0;
            let score2 = 0;

            for (const obj of projObjects) {
                if (!(obj instanceof LogicProjectileClient)) continue;
                const proj = obj as LogicProjectileClient;
                if (proj.getTeamIndex() === ownTeam) continue;

                const px = proj.getX();
                const py = proj.getY();
                const d1 = (px - dodgeX1) * (px - dodgeX1) + (py - dodgeY1) * (py - dodgeY1);
                const d2 = (px - dodgeX2) * (px - dodgeX2) + (py - dodgeY2) * (py - dodgeY2);
                if (d1 < d2) score1++;
                else score2++;
            }

            // Pick direction further from projectiles (lower score = fewer nearby projectiles)
            const dodgeX = score1 <= score2 ? dodgeX1 : dodgeX2;
            const dodgeY = score1 <= score2 ? dodgeY1 : dodgeY2;

            const dodgeInput = new ClientInput(ClientInputType.Movement);
            dodgeInput.setXY(dodgeX, dodgeY);
            ClientInputManager.addInput(dodgeInput);
        } catch (e) {
            console.error("LogicBattleModeClient::tickAutoDodge error:", e);
        }
    }

    getOwnPlayerTeam() {
        return LogicBattleModeClient.getOwnPlayerTeam(this.instance);
    }

    getOwnPlayer() {
        return this.getPlayer(LogicBattleModeClient.getOwnPlayerIndex(this.instance));
    }

    isGameOver() {
        return this.instance.add(LogicBattleModeClient_currentBattleStateOffset).readInt() !== -1;
    }

    findBulletXY(globalId: number): number[] | undefined {
        return this.bulletXY.find(x => x[0] == globalId);
    }

    pushBulletXY(globalId: number, x: number, y: number): void {
        this.bulletXY.push([globalId, x, y]);
    }

    getPlayer(index: number): LogicPlayer {
        return LogicBattleModeClient.getPlayer(this.instance, index);
    }

    static getPlayer(self: NativePointer, index: number): LogicPlayer {
        return new LogicPlayer(
            self.readPointer().add(Process.pointerSize * index).readPointer()
        );
    }

    static getGameObjects(logicBattleModeClient: NativePointer) {
        return logicBattleModeClient.readPointer();
    }

    static getOwnCharacter(logicBattleModeClient: NativePointer): NativePointer {
        return LogicBattleModeClient_getOwnCharacter(logicBattleModeClient);
    }

    static getOwnPlayerIndex(logicBattleModeClient: NativePointer): number {
        return logicBattleModeClient.add(LogicBattleModeClient_ownPlayerIndexOffset).readInt();
    }

    static getOwnPlayerTeam(logicBattleModeClient: NativePointer): number {
        return logicBattleModeClient.add(LogicBattleModeClient_ownPlayerTeamOffset).readInt();
    }

    static getTileMap(logicBattleModeClient: NativePointer): LogicTileMap {
        return new LogicTileMap(
            logicBattleModeClient.add(LogicBattleModeClient_tileMapOffset).readPointer()
        );
    }

    static isUnderdog(self: NativePointer): boolean {
        return Boolean(self.add(LogicBattleModeClient_underdogOffset).readU8());
    }

    static patch() {
        Interceptor.replace(LogicBattleModeClient_update, new NativeCallback(function (battleModeClient, a1, a2) {
            LogicBattleModeClient_update(battleModeClient, a1, a2);

            if (!LogicBattleModeClient.self || !LogicBattleModeClient.self.instance.equals(battleModeClient)) {
                new LogicBattleModeClient(battleModeClient);
            }

            // ain't we already

            LogicBattleModeClient.self.tick();
        }, 'void', ['pointer', 'float', 'float']));
    }
}