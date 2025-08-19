from __future__ import annotations
from dataclasses import dataclass, field, replace
import random
import copy

@dataclass
class Geheimnis:
    name: str
    text: str


@dataclass(frozen=True)
class Keyword:
    name: str
    text: str
    category: int
    value: int | None = None


@dataclass(frozen=True)
class Attacke:
    name: str
    text: str
    type: int  #0 für normale Attacke, 1 für Rangelei, 2 für background Attacke (hauptsächlich für events)
    targets: list[bool] = field(default_factory=lambda: [0, 0, 0, 0])  #t_1, t_atk, t_stk, t_2
    keywords: list[Keyword] = field(default_factory=list)


@dataclass
class AttackeBesitz:
    attacke: Attacke
    x_keywords: list[Keyword] = field(default_factory=list)
    n_used: int = 0
    last_used: int = -100  #Zeit des Zugebeginnes, dem das Zeitfenster gehört, in welchem die Attacke verwendet wurde


@dataclass
class Stats:
    leben: int = 500
    maxLeben: int = 500
    spott: bool = 0  # wenn ein charakter ohne spott schaden bekommen sollte, kriegt stattdessen ein zufälliger
    # charakter mit Spott Schaden
    wut: int = 0
    heil_wut: int = 0
    reduction: int = 0
    atk_eingesetzt: (bool, bool) = (False, False)  #vorher/nachher window, resettet am eigenen zuganfang dort nur window 1
    # nutzbar
    dmgmod: int = 0
    n_selbstschaden: int = 0
    n_attacken: int = 0
    geheimnisse: list[Geheimnis] = field(default_factory=list)
    ausgelöst: list[Geheimnis] = field(default_factory=list)
    attacken: list[AttackeBesitz] = field(default_factory=list)


@dataclass
class Monster:
    stats: Stats
    spieler_id: int
    is_monster: bool = True


@dataclass
class Spieler:
    spieler_id: int
    name: str
    monster: list[Monster] = field(default_factory=list)
    stats: Stats = field(default_factory=Stats)
    gy: list[Monster] = field(default_factory=list)
    atk_known: list[AttackeBesitz] = field(default_factory=list)
    stop_start: bool = 0  #Spieler möchte Priority am Zuganfang kriegen
    stop_end: bool = 0  #Spieler möchte Priority an der Zugmitte kriegen
    stop_react: bool = 0  #Spieler möchte Priority als Reaktion auf den Gegner kriegen
    is_monster: bool = False


@dataclass
class AttackeEingesetzt:
    attacke: Attacke
    owner: Spieler | Monster
    ausgeführt: int = 0  #0 bei auf dem stack, 1 bei ausgeführt, 2 bei gekontert
    mod: int = 0
    t_1: Spieler | Monster | None = None  #Charaktertarget 1
    t_atk: AttackeBesitz | None = None  #Attackentarget von dem t_1
    t_stk: int | None = None  #Stacktarget
    t_2: Spieler | Monster | None = None  #Charaktertarget 2 / Optional
    nodmg: bool = False


@dataclass
class Stack:
    attacken: list[AttackeEingesetzt] = field(default_factory=list)


@dataclass
class Event:
    time: int
    event: AttackeEingesetzt


Einmalig = Keyword(name="Einmalig", text="kann nur einmal eingesetzt werden", category=0, value=1)
Zweimalig = Keyword(name="Zweimalig", text="kann nur zweimal eingesetzt werden", category=0, value=2)
Dreimalig = Keyword(name="Dreimalig", text="kann nur dreimal eingesetzt werden", category=0, value=3)
Super3 = Keyword(name="Super3", text="kann nur alle drei Züge eingesetzt werden", category=1, value=3)
Passiv = Keyword(name="Passiv", text="hat einen passiven Effekt", category=2)
Extra = Keyword(name="Extra", text="kann zusätzlich zu deiner einen Attacke pro Zeitslot eingesetzt werden", category=3)
Schnell = Keyword(name="Schnell", text="kann auch an anderen Zeitpunkten als deiner Zugmitte gespielt werden",
                  category=4)
nicht_Schnell = Keyword(name="nicht Schnell", text="kann immer nur in deiner Zugmitte eingesetzt werden", category=5)
kein_Schaden = Keyword(name="kein Schaden", text="Attacke kann keinen Schaden machen", category=6)

Alles_oder_nichts = Attacke(name="Alles oder nichts",
                            text="Wähle eine deiner nicht Xmalig- und nicht Superattacken und "
                                 "entferne sie vom Spiel. Führe sie am Ende des nächsten gegnerischen Zuges "
                                 "zweimal aus",
                            keywords=[Einmalig], type=0, targets=[True, True, 0, 0])
Alles_wird_gut = Attacke(name="Alles wird gut!", text="Belebe zwei zufällige Monster wieder", keywords=[Einmalig],
                         type=0)
Bitte_extra = Attacke(name="Bitte extra!", text="Kontere eine Extra Attacke", keywords=[Extra, Schnell, Dreimalig],
                      type=0, targets=[0, 0, True, 0])
Feuerkobold = Attacke(name="Feuerkobold", text='Beschwöre ein 0/50 Monster. Verursache 50 Schaden', keywords=[],
                      type=0, targets=[True, 0, 0, 0])
Feurige_Waffen = Attacke(name="Feurige Waffen", text="Erhalte diesen Zug 10 Wut", keywords=[Einmalig, Extra], type=0)
Finale = Attacke(name="Finale", text="150 Schaden", keywords=[Einmalig], type=0, targets=[True, 0, 0, 0])
Finales_Ritual = Attacke(name="Finales Ritual", text="(Menge dir Zugefügtem Schaden in deinem eigenen Zug) Schaden",
                         keywords=[Einmalig], type=0, targets=[True, 0, 0, 0])
Freund_der_Tiere = Attacke(name="Freund der Tiere", text="Beschwöre ein 50/50 Monster", keywords=[], type=0)
Gedankenkontrolle = Attacke(name="Gedankenkontrolle (WIP)",
                            text="Dein Gegner verrät dir seine Attacken. Wähle dann eine seiner Attacken, setze sie "
                                 "ein, so als würde sie der Gegner einsetzen",
                            keywords=[Dreimalig], type=0)
Geheime_Mission = Attacke(name="Geheime Mission", text="90 Schaden. Nicht konterbar", keywords=[], type=0,
                          targets=[True, 0, 0, 0])
Gelbe_Karte = Attacke(name="Gelbe Karte",
                      text="100 Schaden. Ist dies die genau zweite ausgeführte gelbe Karte? Stattdessen 250 Schaden",
                      keywords=[Einmalig], type=0, targets=[True, 0, 0, 0])
Geschenk_des_Lebens = Attacke(name="Geschenk des Lebens", text="Verleihe allen freundlichen Monstern +50 Leben",
                              keywords=[], type=0)
Gleichheit = Attacke(name="Gleichheit", text="Gleiche die Leben deines Gegners deinen Leben an",
                     keywords=[nicht_Schnell], type=0)
Hartes_Training = Attacke(name="Hartes Training", text="Erhalte 10 Wut", keywords=[], type=0)
Heilung = Attacke(name="Heilung", text="Heile 100 Leben", keywords=[Super3], type=0, targets=[True, 0, 0, 0])
Immer_vorbereitet = Attacke(name="Immer vorbereitet",
                            text="Wähle vor Spielbeginn 3 Rangeleien und füge sie zu deinen Attacken hinzu",
                            keywords=[Passiv], type=0)
Karnickel = Attacke(name="Karnickel", text="Beschwöre drei 0/10 Monster", keywords=[], type=0)
Konter = Attacke(name="Konter", text="Kontere eine Attacke", keywords=[Schnell, Super3], type=0,
                 targets=[0, 0, True, 0])
Langsam_aber_sicher = Attacke(name="Langsam, aber sicher",
                              text="10 * (Anzahl von dir erfolgreich ausgeführter Attacken) Schaden", keywords=[],
                              type=0, targets=[True, 0, 0, 0])
Lebender_Baum = Attacke(name="Lebender Baum", text="Beschwöre ein 0/150 Monster", keywords=[Super3], type=0)
Lebender_Schild = Attacke(name="Lebender Schild", text="Wähle einen Charakter. Verleihe ihm Spott",
                          keywords=[], type=0, targets=[True, 0, 0, 0])
Lebenslehre = Attacke(name="Lebenslehre", text="Verleihe einem Monster eine deiner nicht Xmalig- nicht Superattacken",
                      keywords=[], type=0, targets=[True, True, 0, True])
Lehren = Attacke(name="Lehren", text="Verleihe einem Charakter die Attacke Schwertschalag", keywords=[], type=0,
                 targets=[True, 0, 0, 0])
Letzte_Chance = Attacke(name="Letzte Chance (WIP)",
                        text="Wenn du das nächste Mal tödlichen Schaden bekommen würdest, negiere jenen Schaden und "
                             "heile dir 50 Leben",
                        keywords=[Einmalig], type=0)
Letzter_Wille = Attacke(name="Letzter Wille", text="5 Mal 20 Schaden", keywords=[Einmalig], type=0,
                        targets=[True, 0, 0, 0])
Meister_der_Magie = Attacke(name="Meister der Magie", text="30*(Anzahl ausgelöster Geheimnisse) Schaden", keywords=[],
                            type=0, targets=[True, 0, 0, 0])
Messerstich = Attacke(name="Messerstich", text="20 Schaden", keywords=[Extra], type=0, targets=[True, 0, 0, 0])
Messerwürfe = Attacke(name="Messerwürfe", text="4 Mal 20 Schaden", keywords=[], type=0, targets=[True, 0, 0, 0])
Metallschild = Attacke(name="Metallschild", text="Attacken des Gegners machen 10 Schaden weniger", keywords=[Passiv],
                       type=0)
Opfer = Attacke(name="Opfer (WIP)",
                text="Vernichte ein freundliches Monster. Alle befreundeten Charaktere erhalten seine Leben",
                keywords=[], type=0, targets=[True, 0, 0, 0])
Prestige = Attacke(name="Prestige (WIP)", text="erhalte alle in diesen Spiel ausgelösten Geheimnisse", keywords=[Einmalig],
                   type=0)
Schild_und_Schwert = Attacke(name="Schild und Schwert", text="Verhindere 50 Schaden. 50 Schaden", keywords=[Schnell],
                             type=0, targets=[True, 0, True, 0])
Schneesturm = Attacke(name="Schneesturm",
                      text="Jedes Mal wenn ein Spieler eine Attacke in seinem eigenen Zug erfolgreich ausführt "
                           "erleidet er 10 Schaden. Jedes Mal wenn ein Spieler eine Attacke im Zug seines Gegners "
                           "erfolgreich ausführt, erleidet dieser Gegner 10 Schaden",
                      keywords=[Passiv], type=0)
Schnell_Atk = Attacke(name="Schnell", text="Bevor dem Zugende: verleihe einer deiner Attacken bis zum Zugende Schnell",
                      keywords=[Extra, Schnell], type=0, targets=[True, True, 0, 0])
Schneller = Attacke(name="Schneller",
                    text="Verleihe eine deiner Attacken in diesem Zug schnell und „Diese Attacke kann keinem Gegner "
                         "Schaden machen“",
                    keywords=[Extra, Zweimalig, Schnell], type=0, targets=[True, True, 0, 0])
Schwertschlag = Attacke(name="Schwertschlag", text="100 Schaden", keywords=[], type=0, targets=[True, 0, 0, 0])
Seelenschlag = Attacke(name="Seelenschlag", text="120 Schaden. Du erleidest 50 Schaden", keywords=[], type=0,
                       targets=[True, 0, 0, 0])
Sichere_und_geheime_Mission = Attacke(name="Sichere und geheime Mission",
                                      text="60 Schaden. Nicht konterbar. Schaden nicht veränderbar", keywords=[Schnell],
                                      type=0, targets=[True, 0, 0, 0])
Sicherer_Schlag = Attacke(name="Sicherer Schlag", text="90 Schaden. Schaden nicht veränderbar", keywords=[], type=0,
                          targets=[True, 0, 0, 0])
Spiegelschild = Attacke(name="Spiegelschild (WIP)",
                        text="Wenn du das nächste Mal durch einen Gegner Schaden bekommen würdest, kriegt stattdessen "
                             "dieser Gegner so viel Schaden",
                        keywords=[Einmalig], type=0)
Verführerisches_Angebot = Attacke(name="Verführerisches Angebot",
                                  text="Du hast 100 Leben weniger. Du kannst 2 Attacken mehr haben", keywords=[Passiv],
                                  type=0)
Verrat = Attacke(name="Verrat", text="80 Schaden", keywords=[Schnell], type=0, targets=[True, 0, 0, 0])
Vorbereitung = Attacke(name="Vorbereitung", text="Deine nächste Attacke die Schadenmacht, verursacht +30 Schaden",
                       keywords=[], type=0)
Wachsames_Auge = Attacke(name="Wachsames Auge",
                         text="Dein Gegner verrät dir seine Attacken, wähle eine von ihnen aus. Er kann sie für 2 "
                              "Züge nicht einsetzen",
                         keywords=[Einmalig, Extra, Schnell], type=0)
Waffen_weg = Attacke(name="Waffen weg!", text="Dein Gegner führt alle seine Attacken aus, sie haben keinen Effekt",
                     keywords=[Einmalig, Extra], type=0)
Wand = Attacke(name="Wand", text="Beschwöre ein 0/50 Monster mit Spott", keywords=[Zweimalig], type=0)
Wut = Attacke(name="Wut", text="Deine nächste Attacke die Schaden macht, verursacht +20 Schaden",
              keywords=[Einmalig, Extra], type=0)
Zauberkunststück = Attacke(name="Zauberkunststück (WIP)",
                           text="Wähle eines von drei zufälligen Geheimnissen, der Nummern 1-7", keywords=[], type=0)
Zaubertrick = Attacke(name="Zaubertrick (WIP)", text="erhalte ein zufälliges Geheimnis", keywords=[], type=0)
Zellteilung = Attacke(name="Zellteilung (WIP)",
                      text="Opfere eines deiner Monster. Beschwöre ein Monster mit gleichen Leben und Attacken wie "
                           "das geopferte Monster am Ende deines Übernächsten Zuges zweimal",
                      keywords=[], type=0, targets=[True, 0, 0, 0])
Zwei_Wünsche = Attacke(name="Zwei Wünsche", text="Kontere eine Attacke", keywords=[Zweimalig, Schnell], type=0,
                       targets=[0, 0, True, 0])
Zweite_Chance = Attacke(name="Zweite Chance", text="Deine X-maligen Attacken sind (X+1)-malig", keywords=[Passiv],
                        type=0)
Zyklus_des_Lebens = Attacke(name="Zyklus des Lebens (WIP)",
                            text="Jedes Mal, wenn ein Monster ohne eine Geboren-Marke stirbt, wähle genau eine der "
                                 "beiden Optionen aus: 1. Notiere dir die Leben und Attacken des Monsters 2. Belebe "
                                 "ein von dir notiertes Monster mit anderen Leben als das gestorbene Monster mit "
                                 "einer Geboren-Marke wider. Streiche es von deinen notierten Monstern",
                            keywords=[Passiv], type=0)
Über_dem_Horizont = Attacke(name="Über dem Horizont", text="erhalte 120 Leben", keywords=[Einmalig, Schnell], type=0,
                            targets=[True, 0, 0, 0])
Doppelter_Spott = Attacke(name="Doppelter Spott", text="Verleihe 1-2 Gegnern Spott",
                          keywords=[Zweimalig, Extra], type=1, targets=[True, 0, 0, True])
Einen_Schritt_voraus = Attacke(name="Einen Schritt voraus",
                               text="Kontere eine Attacke, die eine deiner Attacken kontert",
                               keywords=[Zweimalig, Extra, Schnell], type=1, targets=[0, 0, True, 0])
Gedankenkontrolle2 = Attacke(name="Gedankenkontrolle",
                             text='Dein Gegner setzt die Attacke ein: "Füge dir selbst 60 Schaden zu"', keywords=[],
                             type=1)
Geschwindigkeitstraining = Attacke(name="Geschwindigkeitstraining", text="Verleihe einer Attacke schnell", keywords=[],
                                   type=1, targets=[True, True, 0, 0])
Grüne_Karte = Attacke(name="Grüne Karte", text="In diesem Spiel wurde eine gelbe Karte weniger ausgespielt",
                      keywords=[Einmalig, Extra], type=1)
Grüne_Wiese = Attacke(name="Grüne Wiese",
                      text="Wenn Charaktere eine Attacke nicht in ihrem eigenen Zug ausführen, verursachen jene "
                           "Attacken 20 Schaden weniger",
                      keywords=[Passiv], type=1)
Gutes_Auge = Attacke(name="Gutes Auge (WIP)", text="Übernimm die Kontrolle über zwei zufällige Geheimnisse",
                     keywords=[Einmalig], type=1)
Heilung2 = Attacke(name="Heilung", text="Heile 80 Leben", keywords=[Super3], type=1, targets=[True, 0, 0, 0])
Neu_geboren = Attacke(name="Neu geboren", text="Setze die Leben eines Gegners auf 500", keywords=[Extra],
                      type=1)
Ruhe = Attacke(name="Ruhe", text="Alle Attacken machen ab jetzt 30 Schaden weniger und geben 30 Leben weniger",
               keywords=[Einmalig, Schnell], type=1)
Sandsturm = Attacke(name="Sandsturm", text="Füge allen Gegnern 50 Schaden zu", keywords=[], type=1)
Schuss_und_Schlag = Attacke(name="Schuss und Schlag (WIP)",
                            text="Wähle bis zu zwei Ziele. Ziel 1 kriegt 70 Schaden und Ziel 2 30 + überschüssigen "
                                 "Schaden",
                            keywords=[], type=1, targets=[True, 0, 0, True])
Schwertschlag2 = Attacke(name="Schwertschlag", text="80 Schaden", keywords=[], type=1, targets=[True, 0, 0, 0])
Wachsames_Auge2 = Attacke(name="Wachsames Auge", text="Dein Gegner verrät dir seine Attacken",
                          keywords=[Einmalig, Extra], type=1)
Wieder_normal = Attacke(name="Wieder normal", text="Zerstöre eine Passivattacke", keywords=[Schnell], type=1,
                        targets=[True, True, 0, 0])

erhalte_Schnell = Attacke(name="Event - erhalte Schnell", text="verleihe einer Attacke schnell", type=2)
entferne_Schnell = Attacke(name="Event - entferne Schnell", text="entferne Schnell von einer Attacke", type=2)
entferne_Schnell_Schaden = Attacke(name='Event - Effekt von "Schneller" abgelaufen'
                                   , text="entferne Schnell und Attacke kann keinen Schaden machen von einer Attacke",
                                   type=2)
entferne_Wut = Attacke(name="Event - entferne Wut", text="entferne 10 Wut", type=2)


@dataclass
class Client:
    client: object
    spieler: Spieler


@dataclass
class Lobby:
    id: str
    clients: list[Client]
    starting: int | None = None
    priority: int | None = None
    phase: int = 0  #phase, 0 pre-game phase, 1 leben Zahlen phase, 2 kampf phase, 3 kampf ende phase
    reaktion: bool = False
    turntime: int = -1  #0 turn beginning1, 1 turn beginning2, 2 turn mitte1, 3 turn ende2, 4 turn ende1, 5 next turn
    events: list[Event] = field(default_factory=list)
    stack: Stack = field(default_factory=Stack)
    winner: str | None = None
    n_gelbe_Karte: int = 0
    atkmod: int = 0
    healmod: int = 0


lobbies = []


async def ask_targets(client, t_1: bool = False, t_atk: bool = False, t_stk: bool = False, t_2: bool = False):
    a, b, c, d = None, None, None, None
    if t_atk:
        a, b = await client.getatktarget()  #TODO
    elif t_1:
        a = await client.getcharactertarget()  # TODO
    if t_stk:
        c = await client.getstacktarget()  #TODO
    if t_2:
        d = await client.getcharactertarget()  #TODO
    return a, b, c, d


async def attacke_gewählt(lobby: Lobby, owner: Spieler | Monster, attacke: AttackeBesitz):
    if lobby.phase == 2:
        l = attacke.attacke.targets
        t_1, t_atk, t_stk, t_2 = await ask_targets(lobby.clients[owner.spieler_id].client, l[0], l[1], l[2], l[3])
        await attacke_einsetzen(lobby, owner, attacke, t_1, t_atk, t_stk, t_2)


async def spieler_beitreten(lobbycode: str, spielername: str, client):
    found = False
    for lobby in lobbies:
        if lobby.id == lobbycode:
            match len(lobby.clients):
                case 0:
                    found = True
                    lobby.clients.append(Client(client=client, spieler=Spieler(name=spielername, spieler_id=0)))
                case 1:
                    found = True
                    lobby.clients.append(Client(client=client, spieler=Spieler(name=spielername, spieler_id=1)))
                case 2:
                    await client.message("Lobby ist bereits voll")
                    return False
    if not found:
        lobbies.append(Lobby(lobbycode, [Client(client=client, spieler=Spieler(name=spielername, spieler_id=0))]))
    return True


def atk_entschieden(lobby: Lobby, c1: Client, atken1: list[Attacke], c2: Client, atken2: list[Attacke]):
    if lobby.phase == 0:
        lobby.phase = 1
        count = 0
        for atk in atken1:
            b_atk = AttackeBesitz(attacke=atk)
            c1.spieler.stats.attacken.append(b_atk)
            if Passiv in atk.keywords:
                c2.spieler.atk_known.append(b_atk)
            count += 1
        count = 0
        for atk in atken2:
            b_atk = AttackeBesitz(attacke=atk)
            c2.spieler.stats.attacken.append(b_atk)
            if Passiv in atk.keywords:
                c1.spieler.atk_known.append(b_atk)
            count += 1
        apply_passives(c1.spieler)
        apply_passives(c2.spieler)


def apply_passives(spieler: Spieler):
    if any(ab.attacke is Verführerisches_Angebot for ab in spieler.stats.attacken):
        spieler.stats.maxLeben = 400
        spieler.stats.leben = min(spieler.stats.leben, spieler.stats.maxLeben)


async def leben_zahlen(lobby: Lobby, c1: Client, pay1: int, c2: Client, pay2: int):
    if lobby.phase == 1:
        lobby.phase = 2
        pay1 = max(0, min(pay1, c1.spieler.stats.leben - 200))
        pay2 = max(0, min(pay2, c2.spieler.stats.leben - 200))
        c1.spieler.stats.leben -= pay1
        c2.spieler.stats.leben -= pay2
        if pay1 > pay2:
            lobby.starting = lobby.priority = lobby.clients.index(c1)
            c2.spieler.stats.atk_eingesetzt = (True, False)
        elif pay2 > pay1:
            lobby.starting = lobby.priority = lobby.clients.index(c2)
            c1.spieler.stats.atk_eingesetzt = (True, False)
        else:
            start = random.randint(0, len(lobby.clients) - 1)
            lobby.starting = lobby.priority = start
            lobby.clients[start - 1].spieler.stats.atk_eingesetzt = (True, False)
        await passen(lobby)


async def passen(lobby: Lobby):
    if lobby.phase == 2:
        if not lobby.reaktion:
            found = False
            while not found:
                lobby.turntime += 1
                for event in lobby.events:
                    if event.time == lobby.turntime:
                        lobby.stack.attacken.append(event.event)
                await attacken_ausführen(lobby)
                match lobby.turntime % 10:
                    case 0:
                        pl = lobby.clients[lobby.starting].spieler
                        if pl.stop_start:
                            found = True
                            lobby.priority = lobby.starting
                        pl.stats.atk_eingesetzt = (pl.stats.atk_eingesetzt[1], False)
                        for monster in pl.monster:
                            monster.stats.atk_eingesetzt = (monster.stats.atk_eingesetzt[1], False)
                    case 6:
                        if lobby.clients[lobby.starting].spieler.stop_start:
                            found = True
                            lobby.priority = lobby.starting
                    case 1:
                        if lobby.clients[lobby.starting - 1].spieler.stop_start:
                            found = True
                            lobby.priority = (lobby.starting - 1) % 2
                    case 5:
                        pl = lobby.clients[lobby.starting - 1].spieler
                        if pl.stop_start:
                            found = True
                            lobby.priority = (lobby.starting - 1) % 2
                        pl.stats.atk_eingesetzt = (pl.stats.atk_eingesetzt[1], False)
                        for monster in pl.monster:
                            monster.stats.atk_eingesetzt = (monster.stats.atk_eingesetzt[1], False)
                    case 2:
                        found = True
                        lobby.priority = lobby.starting
                    case 3 | 9:
                        if lobby.clients[lobby.starting - 1].spieler.stop_end:
                            found = True
                            lobby.priority = (lobby.starting - 1) % 2
                    case 4 | 8:
                        if lobby.clients[lobby.starting].spieler.stop_end:
                            found = True
                            lobby.priority = lobby.starting
                    case 7:
                        found = True
                        lobby.priority = (lobby.starting - 1) % 2
        else:
            await attacken_ausführen(lobby)
            lobby.reaktion = False
            lobby.priority = int((lobby.turntime % 2) != lobby.starting)


def is_possible(keys: set[Keyword], last: int, n_used: int, zweite_chance: bool, is_normal: bool, is_my_turn: bool,
                is_first_slot: bool, is_attack_left: bool):
    if last < 0:
        return False
    if last <= 1 and (is_first_slot or is_my_turn):
        return False
    extra = False
    schnell = False
    nicht_schnell = False
    for key in keys:
        match key.category:
            case 0:
                if n_used >= key.value + zweite_chance:
                    return False
            case 1:
                if (last - ((not is_my_turn) * (2 * is_first_slot - 1))) // 2 <= key.value:
                    return False
                # last = Differenz in ZÜGEN  seit letzter Nutzung.
                # Eigener Zug:     last//2 <= key.value
                # Gegnerzug:       is_first_slot prüft, ob wir schon im nächsten Zeitfenster sind,
                #                  Anpassung per ((not is_my_turn) * (2 * is_first_slot - 1))
            case 2:
                return False
            case 3:
                extra = True
            case 4:
                schnell = True
            case 5:
                nicht_schnell = True
    if not extra:
        if is_my_turn:
            if not is_first_slot:
                return False
        elif not is_attack_left:
            return False
    if not ((schnell and not nicht_schnell) or is_normal):
        return False
    return True


def is_my_turn(lobby: Lobby, character: Spieler | Monster):
    id = character.spieler_id
    start = lobby.starting
    time = lobby.turntime
    return (time // 5) % 2 != (id == start)


async def attacke_einsetzen(lobby: Lobby, owner: Spieler | Monster, attacke: AttackeBesitz,
                            t_1: Spieler | Monster | None = None, t_atk: AttackeBesitz | None = None,
                            t_stk: int | None = None, t_2: Spieler | Monster | None = None):
    if lobby.phase == 2:
        id = owner.spieler_id
        if lobby.priority == id:
            start = lobby.starting
            time = lobby.turntime
            is_my_turn = ((time // 5) % 2 != (id == start))
            is_main = is_my_turn and ((time % 5) == 2)
            keys = set(attacke.attacke.keywords) | set(attacke.x_keywords)
            eingesetzt = owner.stats.atk_eingesetzt
            if is_possible(keys, time // 5 - attacke.last_used // 5, attacke.n_used,
                           any(ab.attacke is Zweite_Chance for ab in owner.stats.attacken),
                           (not lobby.reaktion and is_main), is_my_turn, not eingesetzt[0], not (eingesetzt == (True, True))):
                attacke.n_used += 1
                if Extra in keys:
                    if eingesetzt == (True,True):
                        attacke.last_used = (time // 5 + 1) * 5
                    else:
                        attacke.last_used = (time // 5 - (not is_my_turn)) * 5
                else:
                    if eingesetzt == (True, False):
                        attacke.last_used = (time // 5 + 1) * 5
                        owner.stats.atk_eingesetzt = (True, True)
                    else:
                        attacke.last_used = (time // 5 - (not is_my_turn)) * 5
                        owner.stats.atk_eingesetzt = (True, False)
                await lobby.clients[id].client.message("First timeslot: " + str(owner.stats.atk_eingesetzt[0]) + ", Second timeslot: " + str(owner.stats.atk_eingesetzt[1]))
                if kein_Schaden in keys:
                    e_atk = AttackeEingesetzt(attacke=attacke.attacke, owner=owner,
                                              t_1=t_1, t_atk=t_atk, t_stk=t_stk, t_2=t_2, nodmg=True)
                else:
                    e_atk = AttackeEingesetzt(attacke=attacke.attacke, owner=owner,
                                              t_1=t_1, t_atk=t_atk, t_stk=t_stk, t_2=t_2)
                if (not owner.is_monster) and (attacke not in lobby.clients[id - 1].spieler.atk_known):
                    lobby.clients[id - 1].spieler.atk_known.append(attacke)
                lobby.stack.attacken.append(e_atk)
                if lobby.clients[id - 1].spieler.stop_react:
                    lobby.reaktion = True
                    lobby.priority = (id - 1) % 2
                else:
                    if lobby.reaktion:
                        await passen(lobby)
                    else:
                        await attacken_ausführen(lobby)
            # am Ende von attacke_einsetzen(...)

            else:
                # vorher:
                # await lobby.clients[id].client.message("Attacke nicht einsetzbar")
                reason = "kein Priority" if lobby.priority != id else "Bedingungen (Fenster/Keywords) nicht erfüllt"
                await lobby.clients[id].client.message(f"Attacke nicht einsetzbar – {reason}")
        else:
            await lobby.clients[id].client.message("Attacke nicht einsetzbar – kein Priority")


def other_spott(lobby: Lobby, target: Spieler | Monster):
    if target.stats.spott:
        return target
    else:
        if target.is_monster:
            pl = lobby.clients[target.spieler_id].spieler
            possibles = []
            if pl.stats.spott:
                possibles.append(pl)
            for mon in pl.monster:
                if mon.stats.spott:
                    possibles.append(mon)
            if not possibles:
                return target
            else:
                return random.choice(possibles)
        else:
            possibles = []
            for mon in target.monster:
                if mon.stats.spott:
                    possibles.append(mon)
            if not possibles:
                return target
            else:
                return random.choice(possibles)


def real_damage_calc(lobby: Lobby, damage: int, attacke: AttackeEingesetzt, target: Spieler | Monster, anzahl: int = 1):
    if attacke.nodmg:
        return 0
    else:
        owner = attacke.owner
        mod = owner.stats.dmgmod
        owner.stats.dmgmod = 0
        if is_my_turn(lobby, owner):
            return max(0, damage + owner.stats.wut + mod + lobby.atkmod - target.stats.reduction + attacke.mod - (
                    sum(ab.attacke is Metallschild for ab in target.stats.attacken) * 10)) * anzahl
        else:
            wiesen = 0
            for client in lobby.clients:
                for atk in client.spieler.stats.attacken:
                    if atk.attacke is Grüne_Wiese:
                        wiesen += 1
                for mon in client.spieler.monster:
                    for atk in mon.stats.attacken:
                        if atk.attacke is Grüne_Wiese:
                            wiesen += 1
            return max(0, damage + owner.stats.wut + mod + lobby.atkmod - target.stats.reduction + attacke.mod - (
                    sum(ab.attacke is Metallschild for ab in target.stats.attacken) * 10) - (wiesen * 20)) * anzahl


def damage(lobby: Lobby, damage: int, attacke: AttackeEingesetzt, anzahl: int = 1):
    target = attacke.t_1
    target = other_spott(lobby, target)
    damage = real_damage_calc(lobby, damage, attacke, target, anzahl)
    target.stats.leben -= damage
    if is_my_turn(lobby, target):
        target.stats.n_selbstschaden += damage


def all_damage(lobby: Lobby, damage: int, attacke: AttackeEingesetzt):
    target = attacke.t_1
    damage = real_damage_calc(lobby, damage, attacke, target)
    if is_my_turn(lobby, target):
        target.stats.n_selbstschaden += damage
        target.stats.leben -= damage
        for mon in target.monster:
            mon.stats.n_selbstschaden += damage
            mon.stats.leben -= damage
    else:
        target.stats.leben -= damage
        for mon in target.monster:
            mon.stats.leben -= damage


def add_wut(target: Spieler | Monster, mod: int):
    target.stats.wut += mod


def dmg_mod(target: Spieler | Monster, mod: int):
    target.stats.dmgmod += mod


def ist_konterbar(attacke: Attacke):
    if attacke.name in ["Geheime Mission", "Sichere und geheime Mission"]:
        return False
    else:
        return True


def check_monster(lobby: Lobby):
    for client in lobby.clients:
        alive = []
        for mon in client.spieler.monster:
            if mon.stats.leben > 0:
                alive.append(mon)
            else:
                client.spieler.gy.append(mon)
        client.spieler.monster = alive


async def check_winner(lobby: Lobby):
    if lobby.winner is None:
        survivors = []
        for client in lobby.clients:
            if client.spieler.stats.leben > 0:
                survivors.append(client.spieler.name)
        l = len(survivors)
        if l == 0:
            lobby.phase = 3
            lobby.winner = "Tie"
            for client in lobby.clients:
                await client.client.win()
        elif l == 1:
            lobby.phase = 3
            lobby.winner = survivors[0]
            for client in lobby.clients:
                await client.client.win()


def block(lobby: Lobby, target: int, mod: int):
    lobby.stack.attacken[target].mod -= mod


def real_heal_calc(lobby: Lobby, attacke: AttackeEingesetzt, mod: int):
    return max(0, min(mod + lobby.healmod + attacke.owner.stats.heil_wut,
                      attacke.t_1.stats.maxLeben - attacke.t_1.stats.leben))


def heilen(lobby: Lobby, attacke: AttackeEingesetzt, mod: int):
    mod = real_heal_calc(lobby, attacke, mod)
    attacke.t_1.stats.leben += mod


def monster(lobby: Lobby, owner: Spieler | Monster, angriff: int, leben: int, spott: bool = 0):
    lobby.clients[owner.spieler_id].spieler.monster.append(
        Monster(stats=Stats(leben=leben, maxLeben=leben, spott=spott, atk_eingesetzt=(True, False), attacken=[
            AttackeBesitz(Attacke(name="Schaden", text=str(angriff) + " Schaden", type=0,targets=[True,0,0,0]))]),
                spieler_id=owner.spieler_id))


def resurrect(lobby: Lobby, target: Spieler | Monster):
    sp = lobby.clients[target.spieler_id].spieler
    if sp.gy:
        mon = random.choice(sp.gy)
        mon.stats = Stats(leben=mon.stats.maxLeben, maxLeben=mon.stats.maxLeben, attacken=mon.stats.attacken,
                          spott=mon.stats.spott, atk_eingesetzt=(True, False))
        sp.monster.append(mon)
        sp.gy.remove(mon)


def konter(lobby: Lobby, target: int):
    atk = lobby.stack.attacken[target]
    if atk.ausgeführt == 0:
        if ist_konterbar(atk.attacke):
            atk.ausgeführt = 2


def lehre(target1: Spieler | Monster, target2: AttackeBesitz):
    target1.stats.attacken.append(copy.deepcopy(target2))


def erhalte_leben(target: Spieler | Monster, mod):
    target.stats.maxLeben += mod
    target.stats.leben += mod


def is_konter_attacke(attacke: Attacke):
    if attacke.name in ["Konter", "Einen Schritt voraus", "Zwei Wünsche", "Bitte extra!"]:
        return True
    return False


def verraten(lobby: Lobby, owner: Spieler | Monster):
    for attacke in lobby.clients[owner.spieler_id - 1].spieler.stats.attacken:
        if attacke not in lobby.clients[owner.spieler_id].spieler.atk_known:
            lobby.clients[owner.spieler_id].spieler.atk_known.append(attacke)


def add_key(keyword: Keyword, atk: AttackeBesitz):
    if keyword not in atk.x_keywords:
        atk.x_keywords.append(keyword)


def remove_key(keyword: Keyword, atk: AttackeBesitz):
    if keyword in atk.x_keywords:
        atk.x_keywords.remove(keyword)


def attacke_zerstören(target1: Spieler | Monster, target2: AttackeBesitz):
    if target2 in target1.stats.attacken:
        target1.stats.attacken.remove(target2)


async def attacken_ausführen(lobby: Lobby):
    if lobby.phase == 2:
        stk_atk = lobby.stack.attacken
        counter = 1
        if stk_atk:
            while stk_atk[-counter].ausgeführt != 1:
                atk = stk_atk[-counter]
                if atk.ausgeführt == 0:
                    atk.ausgeführt = 1
                    if atk.attacke.type != 2:
                        atk.owner.stats.n_attacken += 1
                        if not atk.owner.is_monster:
                            stürme = 0
                            for client in lobby.clients:
                                for attacke in client.spieler.stats.attacken:
                                    if attacke.attacke is Schneesturm:
                                        stürme += 1
                                for mon in client.spieler.monster:
                                    for attacke in mon.stats.attacken:
                                        if attacke.attacke is Schneesturm:
                                            stürme += 1
                            if stürme > 0:
                                if is_my_turn(lobby, atk.owner):
                                    atk.owner.stats.leben -= stürme * 10
                                else:
                                    lobby.clients[atk.owner.spieler_id - 1].spieler.stats.leben -= stürme * 10
                                await check_winner(lobby)
                    match atk.attacke.name:
                        case "Alles oder nichts":
                            if atk.t_1 == atk.owner:
                                dupe = replace(atk.t_atk, attacke=replace(atk.t_atk.attacke, type=2))
                                attacke_zerstören(atk.t_1, atk.t_atk)
                                l_ask = dupe.attacke.targets
                                t_1, t_atk, t_stk, t_2 = await ask_targets(lobby.clients[atk.owner.spieler_id].client,
                                                                           l_ask[0], l_ask[1], l_ask[2], l_ask[3])
                                ev = Event(time=(lobby.turntime // 10) * 10 + 10,
                                           event=AttackeEingesetzt(attacke=dupe.attacke, owner=atk.owner, t_1=t_1,
                                                                   t_atk=t_atk, t_stk=t_stk, t_2=t_2))
                                lobby.events.append(ev)
                                lobby.events.append(copy.deepcopy(ev))
                        case "Alles wird gut!":
                            resurrect(lobby, atk.owner)
                            resurrect(lobby, atk.owner)
                        case "Bitte extra!":
                            if Extra in lobby.stack.attacken[atk.t_stk].attacke.keywords:
                                konter(lobby, atk.t_stk)
                        case "Feuerkobold":
                            monster(lobby, atk.owner, 0, 50)
                            damage(lobby, 50, atk)
                        case "Feurige Waffen":
                            atk.owner.stats.wut += 10
                            lobby.events.append(
                                Event((lobby.turntime // 5) * 5 + 5, AttackeEingesetzt(entferne_Wut, atk.owner)))
                        case "Finale":
                            damage(lobby, 150, atk)
                        case "Finales Ritual":
                            damage(lobby, atk.owner.stats.n_selbstschaden, atk)
                        case "Freund der Tiere":
                            monster(lobby, atk.owner, 50, 50)
                        case "Gedankenkontrolle":
                            if atk.attacke.type == 0:
                                verraten(lobby, atk.owner)
                                t_1, t_atk, _, _ = await ask_targets(client=lobby.clients[atk.owner.spieler_id].client,
                                                                     t_atk=True, t_1=True)
                                #Todo
                            else:
                                damage(lobby, 60, atk)
                        case "Geheime Mission":
                            damage(lobby, 90, atk)
                        case "Gelbe Karte":
                            lobby.n_gelbe_Karte += 1
                            if lobby.n_gelbe_Karte != 2:
                                damage(lobby, 100, atk)
                            else:
                                damage(lobby, 250, atk)
                        case "Geschenk des Lebens":
                            for mon in lobby.clients[atk.owner.spieler_id].spieler.monster:
                                erhalte_leben(mon, 50)
                        case "Gleichheit":
                            lobby.clients[atk.owner.spieler_id - 1].spieler.stats.leben = lobby.clients[
                                atk.owner.spieler_id].spieler.stats.leben
                            lobby.clients[atk.owner.spieler_id - 1].spieler.stats.maxLeben = lobby.clients[
                                atk.owner.spieler_id].spieler.stats.maxLeben
                        case "Hartes Training":
                            add_wut(atk.owner, 10)
                        case "Heilung":
                            if atk.attacke.type == 0:
                                heilen(lobby, atk, 100)
                            else:
                                heilen(lobby, atk, 80)
                        case "Karnickel":
                            monster(lobby, atk.owner, 0, 10)
                            monster(lobby, atk.owner, 0, 10)
                            monster(lobby, atk.owner, 0, 10)
                        case "Konter":
                            konter(lobby, atk.t_stk)
                        case "Langsam, aber sicher":
                            damage(lobby, 10 * atk.owner.stats.n_attacken, atk)
                        case "Lebender Baum":
                            monster(lobby, atk.owner, 0, 150)
                        case "Lebender Schild":
                            atk.t_1.stats.spott = 1
                        case "Lebenslehre":
                            if atk.t_1 == atk.owner:
                                keys = set(atk.t_atk.x_keywords) | set(atk.t_atk.attacke.keywords)
                                okay = True
                                for key in keys:
                                    if key.category <= 1:
                                        okay = False
                                if okay:
                                    lehre(atk.t_2, atk.t_atk)
                                    if atk.t_atk not in lobby.clients[atk.owner.spieler_id - 1].spieler.atk_known:
                                        lobby.clients[atk.owner.spieler_id - 1].spieler.atk_known.append(atk.t_atk)
                        case "Lehren":
                            lehre(atk.t_1, AttackeBesitz(attacke=Schwertschlag))
                        case "Letzte Chance":
                            pass
                        case "Letzter Wille":
                            damage(lobby, 20, atk, 5)
                        case "Meister der Magie":
                            damage(lobby, len(atk.owner.stats.ausgelöst) * 30, atk)
                        case "Messerstich":
                            damage(lobby, 20, atk)
                        case "Messerwürfe":
                            damage(lobby, 20, atk, 4)
                        case "Opfer":
                            pass
                        case "Prestige":
                            pass
                        case "Schild und Schwert":
                            damage(lobby, 50, atk)
                            block(lobby, atk.t_stk, 50)
                        case "Schnell":
                            end_time = ((lobby.turntime + 1) // 5) * 5 + 4
                            lobby.events.append(
                                Event(end_time, AttackeEingesetzt(attacke=erhalte_Schnell, owner=atk.owner,
                                                                  t_atk=atk.t_atk)))
                            lobby.events.append(
                                Event(end_time + 1, AttackeEingesetzt(attacke=entferne_Schnell, owner=atk.owner,
                                                                      t_atk=atk.t_atk)))
                        case "Schneller":
                            add_key(Schnell, atk.t_atk)
                            add_key(kein_Schaden, atk.t_atk)
                            lobby.events.append(Event((lobby.turntime // 5) * 5 + 5, AttackeEingesetzt(
                                attacke=entferne_Schnell_Schaden, owner=atk.owner, t_atk=atk.t_atk)))
                        case "Schwertschlag":
                            if atk.attacke.type == 0:
                                damage(lobby, 100, atk)
                            else:
                                damage(lobby, 80, atk)
                        case "Seelenschlag":
                            damage(lobby, 120, atk)
                            old_target = atk.t_1
                            atk.t_1 = atk.owner
                            damage(lobby, 50, atk)
                            atk.t_1 = old_target
                        case "Sichere und geheime Mission":
                            atk.t_1.stats.leben -= 60
                        case "Sicherer Schlag":
                            atk.t_1.stats.leben -= 90
                        case "Spiegelschild":
                            pass
                        case "Verrat":
                            damage(lobby, 80, atk)
                        case "Vorbereitung":
                            dmg_mod(atk.owner, 30)
                        case "Wachsames Auge":
                            if atk.attacke.type == 0:
                                pass
                            else:
                                verraten(lobby, atk.owner)
                        case "Waffen weg!":
                            sp = lobby.clients[atk.owner.spieler_id - 1].spieler
                            for ab in sp.stats.attacken:
                                keys = set(ab.attacke.keywords) | set(ab.x_keywords)
                                if any(k.category == 0 for k in keys):  # Xmalig
                                    ab.n_used += 1
                                if any(k.category == 1 for k in keys):  # SuperN
                                    ab.last_used = (lobby.turntime // 5 - (not is_my_turn(lobby, sp))) * 5 \
                                        if sp.stats.atk_eingesetzt == (False, False) else (lobby.turntime // 5 + (
                                        not is_my_turn(lobby, sp))) * 5
                            verraten(lobby, atk.owner)
                        case "Wand":
                            monster(lobby, atk.owner, 0, 50, True)
                        case "Wut":
                            dmg_mod(atk.owner, 20)
                        case "Zauberkunststück":
                            pass
                        case "Zaubertrick":
                            pass
                        case "Zellteilung":
                            pass
                        case "Zwei Wünsche":
                            konter(lobby, atk.t_stk)
                        case "Zyklus des Lebens":
                            pass
                        case "Über dem Horizont":
                            erhalte_leben(atk.t_1, 120)
                        case "Doppelter Spott":
                            if atk.t_1.spieler_id != atk.owner.spieler_id:
                                atk.t_1.stats.spott = 1
                            if atk.t_1 != atk.t_2:
                                if atk.t_2.spieler_id != atk.owner.spieler_id:
                                    atk.t_2.stats.spott = 1
                        case "Einen Schritt voraus":
                            if is_konter_attacke(lobby.stack.attacken[atk.t_stk].attacke):
                                konter(lobby, atk.t_stk)
                        case "Geschwindigkeitstraining":
                            add_key(Schnell, atk.t_atk)
                        case "Grüne Karte":
                            lobby.n_gelbe_Karte = max(0, lobby.n_gelbe_Karte - 1)
                        case "Gutes Auge":
                            pass
                        case "Neu geboren":
                            lobby.clients[atk.owner.spieler_id - 1].spieler.stats.leben = 500
                            lobby.clients[atk.owner.spieler_id - 1].spieler.stats.maxLeben = 500
                        case "Ruhe":
                            lobby.atkmod -= 30
                            lobby.healmod -= 30
                        case "Sandsturm":
                            all_damage(lobby, 50, atk)
                        case "Schuss und Schlag":
                            pass
                        case "Wieder normal":
                            if Passiv in atk.t_atk.x_keywords or Passiv in atk.t_atk.attacke.keywords:
                                attacke_zerstören(atk.t_1, atk.t_atk)
                        case "Schaden":
                            damage(lobby, int(atk.attacke.text.split(" ")[0]), atk)
                        case "Event - erhalte Schnell":
                            add_key(Schnell, atk.t_atk)
                        case "Event - entferne Schnell":
                            remove_key(Schnell, atk.t_atk)
                        case 'Event - Effekt von "Schneller" abgelaufen':
                            remove_key(Schnell, atk.t_atk)
                            remove_key(kein_Schaden, atk.t_atk)
                        case "Event - entferne Wut":
                            add_wut(atk.owner, -10)
                    await check_winner(lobby)
                    check_monster(lobby)
                if len(stk_atk)>counter:
                    counter += 1
                else:
                    break
