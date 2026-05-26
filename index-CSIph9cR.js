<?php
/**
 * CORTEGE LOGS — главный API файл
 * Все запросы /api/* попадают сюда через .htaccess
 *
 * ════════════════════════════════════════════════
 * ПОДКЛЮЧЕНИЕ ЛОГОВ С СЕРВЕРА (МЕЙЗ ХОСТИНГ):
 *   Игровой сервер делает INSERT в таблицу server_logs.
 *   Строка подключения к MySQL: смотри api/config.php
 *   Поля таблицы: category, sub_category, message, player, admin
 *
 * ПОДКЛЮЧЕНИЕ RCON:
 *   Заполни RCON_HOST, RCON_PORT, RCON_PASSWORD в api/config.php
 * ════════════════════════════════════════════════
 */

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: ' . ($_SERVER['HTTP_ORIGIN'] ?? '*'));
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

ini_set('session.cookie_httponly', 1);
ini_set('session.cookie_samesite', 'Lax');
ini_set('session.use_strict_mode', 1);
session_name('cortege_session');
session_start();

function db(): PDO {
    static $pdo;
    if (!$pdo) {
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    }
    return $pdo;
}

// Подключение к игровой базе данных (Мейз Хостинг, gs336889)
function game_db_error(?string $set = null): string {
    static $err = '';
    if ($set !== null) $err = $set;
    return $err;
}

function game_db(): ?PDO {
    static $pdo;
    static $failed = false;
    if ($failed) return null;
    if (!$pdo) {
        if (GAME_DB_HOST === '' || GAME_DB_NAME === '' || GAME_DB_USER === '') return null;
        try {
            $dsn = 'mysql:host=' . GAME_DB_HOST . ';port=' . GAME_DB_PORT . ';dbname=' . GAME_DB_NAME . ';charset=utf8';
            $pdo = new PDO($dsn, GAME_DB_USER, GAME_DB_PASS, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::ATTR_TIMEOUT            => 10,
            ]);
        } catch (PDOException $e) {
            $failed = true;
            game_db_error($e->getMessage());
            return null;
        }
    }
    return $pdo;
}

// Вернуть имя игрока по acc_id из accounts_1101
function game_player_name(int $acc_id): string {
    $gdb = game_db();
    if (!$gdb) return "ID:$acc_id";
    try {
        $s = $gdb->prepare('SELECT name FROM accounts_1101 WHERE id=? LIMIT 1');
        $s->execute([$acc_id]);
        $r = $s->fetch();
        return $r ? $r['name'] : "ID:$acc_id";
    } catch (PDOException $e) {
        return "ID:$acc_id";
    }
}

// Unix timestamp → MySQL DATETIME строка
function unix_to_dt(int $ts): string {
    return date('Y-m-d H:i:s', $ts);
}

function fetch_game_logs(string $category, string $subCategory, string $search, string $participant, string $date): array {
    $gdb = game_db();
    if (!$gdb) return [];

    $logs = [];
    $qe   = [];  // query errors

    $w0 = []; $p0 = []; // общие фильтры-заготовки

    $fDate     = function(string $field) use ($date, &$w0, &$p0) {
        if ($date) { $w0[] = "DATE($field)=?"; $p0[] = $date; }
    };
    $fDateUnix = function(string $field) use ($date, &$w0, &$p0) {
        if ($date) { $w0[] = "DATE(FROM_UNIXTIME($field))=?"; $p0[] = $date; }
    };
    $fSearch  = function(array $fields) use ($search, &$w0, &$p0) {
        if ($search) {
            $parts = array_map(fn($f) => "$f LIKE ?", $fields);
            $w0[] = '(' . implode(' OR ', $parts) . ')';
            foreach ($fields as $_) $p0[] = "%$search%";
        }
    };
    $fPart    = function(array $fields) use ($participant, &$w0, &$p0) {
        if ($participant) {
            $parts = array_map(fn($f) => "$f LIKE ?", $fields);
            $w0[] = '(' . implode(' OR ', $parts) . ')';
            foreach ($fields as $_) $p0[] = "%$participant%";
        }
    };
    $wSQL = function(array $w, string $prefix = ' WHERE ') {
        return $w ? $prefix . implode(' AND ', $w) : '';
    };

    $need = function(string $cat, string $sub) use ($category, $subCategory): bool {
        $catOk = ($category === '' || $category === $cat);
        $subOk = ($subCategory === '' || $subCategory === $sub);
        return $catOk && $subOk;
    };
    $isGeneral = ($category === '' || ($category === 'Логи' && $subCategory === 'Общие'));

    // Логи/Общие  +  Персонаж/Общие логи персонажа  +  Администрация/Действия администрации (тип admin)
    if ($isGeneral || $need('Логи','Общие') || $need('Персонаж','Общие логи персонажа')) {
        $w=$p=$w0=$p0=[];
        $fDateUnix('al.time');
        $fSearch(['al.description']);
        $fPart(['a.name']);
        try {
            $sql = "SELECT al.id, al.time AS ts, al.type, al.description, al.uip, a.name
                    FROM action_log al LEFT JOIN accounts_1101 a ON a.id=al.acc_id"
                  . $wSQL($w0) . ' ORDER BY al.time DESC LIMIT 300';
            $rows = $gdb->prepare($sql); $rows->execute($p0);
            $tn = [0=>'Неизвестно',1=>'Объявление',2=>'Выдача предмета',3=>'Снятие предмета',
                   4=>'Выдача транспорта',5=>'Выдача денег',6=>'Снятие денег',7=>'Разжалование',
                   8=>'Авторизация',9=>'Бан',10=>'Выдача доната',11=>'Снятие доната',
                   12=>'Кик',13=>'Мут',14=>'Предупреждение'];
            foreach ($rows->fetchAll() as $r) {
                $logs[] = ['id'=>'al_'.$r['id'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>$isGeneral?'Логи':($category?:'Логи'),
                    'subCategory'=>$isGeneral?'Общие':$subCategory,
                    'message'=>'['.(($tn[$r['type']]??'Тип '.$r['type'])).'] '.($r['description']?:'—'),
                    'player'=>$r['name']??'','admin'=>$r['uip']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    // Логи/Общие  +  Логи/Банк (деньги)
    if ($isGeneral || $need('Логи','Общие') || $need('Логи','Банк')) {
        $w0=$p0=[];
        $fDate('ml.time');
        $fSearch(['ml.description']);
        $fPart(['a.name']);
        $w0[] = "ml.time != '0000-00-00 00:00:00'";
        try {
            $sql = "SELECT ml.id,ml.uid,ml.uip,ml.time AS ts,ml.money,ml.description,a.name
                    FROM money_log ml LEFT JOIN accounts_1101 a ON a.id=ml.uid
                    WHERE " . implode(' AND ',$w0) . ' ORDER BY ml.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            $sub = ($need('Логи','Банк') && !$isGeneral) ? 'Банк' : 'Общие';
            foreach ($rows->fetchAll() as $r) {
                $logs[]=[ 'id'=>'ml_'.$r['id'],
                    'timestamp'=>$r['ts'],
                    'category'=>'Логи','subCategory'=>$sub,
                    'message'=>$r['money'].' | '.($r['description']!=='None'?$r['description']:'—'),
                    'player'=>$r['name']??'','admin'=>$r['uip']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    // Логи/Общие
    if ($isGeneral || $need('Логи','Общие')) {
        $w0=$p0=[];
        $fDateUnix('dl.time');
        $fSearch(['dl.description']);
        $fPart(['a.name']);
        try {
            $sql = "SELECT dl.id,dl.uid,dl.uip,dl.time AS ts,dl.donate,dl.description,a.name
                    FROM donate_log dl LEFT JOIN accounts_1101 a ON a.id=dl.uid"
                  . $wSQL($w0) . ' ORDER BY dl.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $sign=$r['donate']>0?'+':'';
                $logs[]=[ 'id'=>'don_'.$r['id'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>'Логи','subCategory'=>'Общие',
                    'message'=>"{$sign}{$r['donate']} донат | ".($r['description']?:'—'),
                    'player'=>$r['name']??'','admin'=>$r['uip']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    // Логи/Инвентарь  +  Персонаж/Инвентарь  +  Логи/Общие
    if ($isGeneral || $need('Логи','Инвентарь') || $need('Персонаж','Инвентарь') || $need('Логи','Общие')) {
        $w0=$p0=[];
        $fDate('il.time');
        $fSearch(['il.items_text','il.text']);
        $fPart(['a.name']);
        try {
            $sql = "SELECT il.id,il.owner_id,il.items_text,il.text,il.time AS ts,a.name
                    FROM items_log il LEFT JOIN accounts_1101 a ON a.id=il.owner_id"
                  . $wSQL($w0) . ' ORDER BY il.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            $sub = $need('Персонаж','Инвентарь') ? 'Инвентарь' : ($need('Логи','Инвентарь') ? 'Инвентарь' : 'Общие');
            $cat = $need('Персонаж','Инвентарь') ? 'Персонаж' : 'Логи';
            foreach ($rows->fetchAll() as $r) {
                $msg=$r['items_text'];if($r['text']&&$r['text']!=='')$msg.=' | '.$r['text'];
                $logs[]=[ 'id'=>'il_'.$r['id'],
                    'timestamp'=>$r['ts'],
                    'category'=>$cat,'subCategory'=>$sub,
                    'message'=>$msg,'player'=>$r['name']??'','admin'=>''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    // Логи/Банк
    if ($need('Логи','Банк')) {
        $w0=$p0=[];
        $fDateUnix('bl.time');
        $fSearch(['bl.description']);
        $fPart(['a.name']);
        try {
            $sql = "SELECT bl.id,bl.acc_id,bl.uip,bl.time AS ts,bl.description,a.name
                    FROM bank_accounts_log bl LEFT JOIN accounts_1101 a ON a.id=bl.acc_id"
                  . $wSQL($w0) . ' ORDER BY bl.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $logs[]=[ 'id'=>'bk_'.$r['id'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>'Логи','subCategory'=>'Банк',
                    'message'=>$r['description']?:'—','player'=>$r['name']??'','admin'=>$r['uip']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    if ($need('Администрация','Действия администрации')) {
        $w0=$p0=[];
        $fDateUnix('al.time');
        $fSearch(['al.type','al.reason']);
        $fPart(['al.name_adm','a.name']);
        try {
            $sql = "SELECT al.acc_id,al.type,al.name_adm,al.time AS ts,al.reason,a.name AS pname
                    FROM alogs al LEFT JOIN accounts_1101 a ON a.id=al.acc_id"
                  . $wSQL($w0) . ' ORDER BY al.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg=$r['type'];if($r['reason']&&$r['reason']!=='')$msg.=' | Причина: '.$r['reason'];
                $logs[]=[ 'id'=>'alog_'.$r['acc_id'].'_'.$r['ts'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>'Администрация','subCategory'=>'Действия администрации',
                    'message'=>$msg,'player'=>$r['pname']??'','admin'=>$r['name_adm']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    if ($need('Администрация','Список администрации')) {
        $w0=$p0=[];
        $fSearch(['a.name']);
        $fPart(['a.name']);
        // Пытаемся найти поле уровня (adminlevel / admin / level)
        try {
            $cols = $gdb->query("SHOW COLUMNS FROM accounts_1101")->fetchAll(PDO::FETCH_COLUMN);
            $levelCol = null;
            foreach (['adminlevel','admin_level','admin','level'] as $c) {
                if (in_array($c,$cols)) { $levelCol=$c; break; }
            }
            if ($levelCol) $w0[] = "a.$levelCol > 0";
            $sql = "SELECT a.id, a.name" . ($levelCol?", a.$levelCol AS lvl":'') . "
                    FROM accounts_1101 a" . $wSQL($w0) . ' ORDER BY a.id DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg = 'ID: '.$r['id'].($levelCol?' | Уровень: '.$r['lvl']:'');
                $logs[]=[ 'id'=>'adm_'.$r['id'],
                    'timestamp'=>date('Y-m-d H:i:s'),
                    'category'=>'Администрация','subCategory'=>'Список администрации',
                    'message'=>$msg,'player'=>$r['name']??'','admin'=>''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    // Баны игроков / Список банов
    if ($need('Баны игроков','Список банов')) {
        // ban_list
        $w0=$p0=[];
        $fDateUnix('bl.time');
        $fSearch(['bl.description','bl.name']);
        $fPart(['bl.name','bl.admin']);
        try {
            $sql="SELECT bl.id,bl.time AS ts,bl.ban_time,bl.ip,bl.description,bl.admin,bl.name FROM ban_list bl"
                .$wSQL($w0).' ORDER BY bl.time DESC LIMIT 200';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $until=$r['ban_time']>0?' до '.date('d.m.Y H:i',(int)$r['ban_time']).' (перм)':' (перм)';
                $msg="Бан{$until} | IP: {$r['ip']}";
                if($r['description']&&$r['description']!=='None')$msg.=' | '.$r['description'];
                $logs[]=[ 'id'=>'ban_'.$r['id'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>'Баны игроков','subCategory'=>'Список банов',
                    'message'=>$msg,'player'=>$r['name']??'','admin'=>$r['admin']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
        // banip_list
        $w0=$p0=[];
        $fSearch(['bl.description','bl.ip']);
        $fPart(['bl.admin','bl.ip']);
        try {
            $sql="SELECT bl.id,bl.time AS ts,bl.ip,bl.description,bl.admin FROM banip_list bl"
                .$wSQL($w0).' ORDER BY bl.id DESC LIMIT 200';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg="IP-бан: {$r['ip']}";if($r['description'])$msg.=' | '.$r['description'];
                $logs[]=[ 'id'=>'bip_'.$r['id'],
                    'timestamp'=>$r['ts']??date('Y-m-d H:i:s'),
                    'category'=>'Баны игроков','subCategory'=>'Список банов',
                    'message'=>$msg,'player'=>'','admin'=>$r['admin']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
        // hardware_bans
        $w0=$p0=[];
        $fSearch(['hb.reason','a.name']);
        $fPart(['a.name']);
        try {
            $sql="SELECT hb.id,hb.hardware_id,hb.type,hb.reason,a.name FROM hardware_bans hb
                  LEFT JOIN accounts_1101 a ON a.id=hb.acc_id".$wSQL($w0).' ORDER BY hb.id DESC LIMIT 200';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            $ht=[0=>'PC',1=>'Телефон',2=>'SAMP'];
            foreach ($rows->fetchAll() as $r) {
                $msg='HWID-бан ('.($ht[$r['type']]??$r['type']).') | '.substr($r['hardware_id'],0,24).'...';
                if($r['reason'])$msg.=' | '.$r['reason'];
                $logs[]=[ 'id'=>'hw_'.$r['id'],
                    'timestamp'=>date('Y-m-d H:i:s'),
                    'category'=>'Баны игроков','subCategory'=>'Список банов',
                    'message'=>$msg,'player'=>$r['name']??'','admin'=>''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
        // localban
        $w0=$p0=[];
        $fSearch(['lb.reason','a.name']);
        $fPart(['lb.by','a.name']);
        try {
            $sql="SELECT lb.id,lb.by,lb.dtime,lb.reason,a.name FROM localban lb
                  LEFT JOIN accounts_1101 a ON a.id=lb.mid".$wSQL($w0).' ORDER BY lb.id DESC LIMIT 200';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg="Лок.бан до: {$r['dtime']}";if($r['reason'])$msg.=' | '.$r['reason'];
                $logs[]=[ 'id'=>'lb_'.$r['id'],
                    'timestamp'=>date('Y-m-d H:i:s'),
                    'category'=>'Баны игроков','subCategory'=>'Список банов',
                    'message'=>$msg,'player'=>$r['name']??'','admin'=>$r['by']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    if ($need('Персонаж','Смена имени')) {
        $w0=$p0=[];
        $fDateUnix('cn.time');
        $fSearch(['cn.name','a.name']);
        $fPart(['cn.name','a.name']);
        try {
            $sql="SELECT cn.id,cn.name AS old_name,cn.time AS ts,cn.ip,a.name AS new_name
                  FROM change_names cn LEFT JOIN accounts_1101 a ON a.id=cn.owner_id"
                 .$wSQL($w0).' ORDER BY cn.time DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $logs[]=[ 'id'=>'cn_'.$r['id'],
                    'timestamp'=>unix_to_dt((int)$r['ts']),
                    'category'=>'Персонаж','subCategory'=>'Смена имени',
                    'message'=>'Смена ника: '.$r['old_name'].' → '.($r['new_name']??'?').' | IP: '.$r['ip'],
                    'player'=>$r['old_name']??'','admin'=>''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    if ($need('Администрация','Муты')) {
        $w0=$p0=[];
        $fSearch(['m.reason','a.name']);
        $fPart(['a.name']);
        try {
            $sql="SELECT m.id,m.dtime,m.by,m.reason,a.name AS pname FROM mutes m
                  LEFT JOIN accounts_1101 a ON a.id=m.mid".$wSQL($w0).' ORDER BY m.id DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg='Мут до: '.($r['dtime']>0?date('d.m.Y H:i',(int)$r['dtime']):'перм');
                if($r['reason'])$msg.=' | '.$r['reason'];
                $logs[]=[ 'id'=>'mu_'.$r['id'],
                    'timestamp'=>date('Y-m-d H:i:s'),
                    'category'=>'Администрация','subCategory'=>'Муты',
                    'message'=>$msg,'player'=>$r['pname']??'','admin'=>$r['by']??''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    if ($need('Репорт багов','Активные') || $need('Репорт багов','Решенные')) {
        $w0=$p0=[];
        $statusWant = ($subCategory === 'Решенные') ? 1 : 0;
        try {
            $cols = $gdb->query("SHOW COLUMNS FROM report_ticket")->fetchAll(PDO::FETCH_COLUMN);
            $hasStatus = in_array('status',$cols);
            if ($hasStatus) { $w0[]='status=?'; $p0[]=$statusWant; }
            $fSearch(array_intersect(['message','text','description'], $cols));
            $fPart(array_intersect(['name','player','author'], $cols));
            $sql="SELECT * FROM report_ticket".$wSQL($w0).' ORDER BY id DESC LIMIT 300';
            $rows=$gdb->prepare($sql);$rows->execute($p0);
            foreach ($rows->fetchAll() as $r) {
                $msg = $r['message']??$r['text']??$r['description']??json_encode($r, JSON_UNESCAPED_UNICODE);
                $ts  = $r['time']??$r['created_at']??$r['date']??null;
                $logs[]=[ 'id'=>'rt_'.$r['id'],
                    'timestamp'=>$ts??(date('Y-m-d H:i:s')),
                    'category'=>'Репорт багов','subCategory'=>$subCategory,
                    'message'=>$msg,
                    'player'=>$r['name']??$r['player']??$r['author']??'','admin'=>''];
            }
        } catch (PDOException $e) { $qe[]=$e->getMessage(); }
    }

    usort($logs, fn($a,$b) => strcmp($b['timestamp'], $a['timestamp']));

    if (!empty($qe)) $GLOBALS['_fetch_errors'] = $qe;
    return array_slice($logs, 0, 500);
}

// Возвращает список разделов из игровой базы (для permissions UI)
function get_game_categories(): array {
    return [
        ['category' => 'Логи',           'subCategories' => ['Общие','Банк','Инвентарь']],
        ['category' => 'Администрация',  'subCategories' => ['Список администрации','Действия администрации','Муты']],
        ['category' => 'Баны игроков',   'subCategories' => ['Список банов']],
        ['category' => 'Персонаж',       'subCategories' => ['Общие логи персонажа','Инвентарь','Смена имени']],
        ['category' => 'Репорт багов',   'subCategories' => ['Активные','Решенные']],
    ];
}

function json_out(mixed $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function json_err(string $msg, int $code = 400): never { json_out(['error' => $msg], $code); }
function body(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?? []) : [];
}
function method(): string { return $_SERVER['REQUEST_METHOD']; }

function hash_pw(string $pw): string {
    return password_hash($pw, PASSWORD_BCRYPT, ['cost' => 10]);
}
function verify_pw(string $pw, string $hash): bool {
    return password_verify($pw, $hash);
}

function current_user(): ?array {
    if (empty($_SESSION['user_id'])) return null;
    $s = db()->prepare('SELECT id,username,role,active FROM app_users WHERE id=? LIMIT 1');
    $s->execute([$_SESSION['user_id']]);
    return $s->fetch() ?: null;
}
function require_user(): array {
    $u = current_user();
    if (!$u) json_err('Нужно войти в аккаунт', 401);
    if (!$u['active'] && $u['role'] !== 'owner') json_err('Аккаунт ожидает активации владельцем', 403);
    return $u;
}
function require_owner(array $u): void {
    if ($u['role'] !== 'owner') json_err('Это действие доступно только главному владельцу', 403);
}
function is_owner_protected(string $username, string $role): bool {
    return strtolower($username) === strtolower(OWNER_USERNAME) || $role === 'owner';
}
function safe_user(array $u): array {
    return [
        'id'        => (int)$u['id'],
        'username'  => $u['username'],
        'role'      => $u['role'],
        'active'    => (bool)$u['active'],
        'protected' => is_owner_protected($u['username'], $u['role']),
    ];
}

function rcon_configured(): bool {
    return RCON_HOST !== '' && RCON_PASSWORD !== '';
}

function rcon_send(string $command): string {
    if (!function_exists('socket_create')) {
        throw new RuntimeException('PHP-расширение sockets не включено на сервере');
    }

    $host     = RCON_HOST;
    $port     = (int) RCON_PORT;
    $password = RCON_PASSWORD;

    // Резолвим хост → IP
    $ip = gethostbyname($host);
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        throw new RuntimeException("RCON: не удалось определить IP для $host");
    }

    $parts = explode('.', $ip);

    // ── Собираем SA-MP/CR:MP RCON пакет ──────────────────────────
    // Формат: "SAMP" + IP(4 байта) + Port(2 байта LE) + тип('r') + len(pw)(2 LE) + pw + len(cmd)(2 LE) + cmd
    $packet  = 'SAMP';
    $packet .= chr((int)$parts[0]).chr((int)$parts[1]).chr((int)$parts[2]).chr((int)$parts[3]);
    $packet .= pack('v', $port);          // port, little-endian 2 байта
    $packet .= 'r';                        // тип пакета — RCON
    $packet .= pack('v', strlen($password)) . $password;
    $packet .= pack('v', strlen($command))  . $command;

    // ── UDP сокет ─────────────────────────────────────────────────
    $sock = socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
    if ($sock === false) {
        throw new RuntimeException('RCON: не удалось создать UDP сокет: ' . socket_strerror(socket_last_error()));
    }

    // Таймаут получения: 3 секунды
    socket_set_option($sock, SOL_SOCKET, SO_RCVTIMEO, ['sec' => 3, 'usec' => 0]);

    $sent = socket_sendto($sock, $packet, strlen($packet), 0, $ip, $port);
    if ($sent === false) {
        socket_close($sock);
        throw new RuntimeException('RCON: ошибка отправки пакета: ' . socket_strerror(socket_last_error($sock)));
    }

    // ── Читаем ответные пакеты ────────────────────────────────────
    // Сервер может прислать несколько пакетов подряд (длинный вывод)
    $output    = '';
    $deadline  = microtime(true) + 3.0;

    while (microtime(true) < $deadline) {
        $buf      = '';
        $fromHost = '';
        $fromPort = 0;

        $bytes = @socket_recvfrom($sock, $buf, 4096, 0, $fromHost, $fromPort);

        if ($bytes === false || $bytes < 12) break;

        // Проверяем сигнатуру и тип
        if (substr($buf, 0, 4) !== 'SAMP') continue;
        $type = isset($buf[10]) ? $buf[10] : '';
        if ($type !== 'r') continue;

        // Смещение 11: 2 байта длина сообщения, затем само сообщение
        if (strlen($buf) < 13) continue;
        $msgLen = unpack('v', substr($buf, 11, 2))[1];
        if ($msgLen <= 0) break; // пустое сообщение = конец вывода

        $msg = substr($buf, 13, $msgLen);
        if ($msg !== false && trim($msg) !== '') {
            $output .= $msg . "\n";
        }
    }

    socket_close($sock);

    // Чистим SA-MP/CR:MP служебные символы из ответа:
    // \x07 — BEL (префикс сообщений), {RRGGBB} — цветовые коды, \r
    $output = preg_replace('/\{[0-9A-Fa-f]{6}\}/', '', $output); // {FF0000} цвета
    $output = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $output); // управляющие символы кроме \n \t
    $output = str_replace("\r", '', $output);

    return trim($output) !== '' ? trim($output) : '(сервер не вернул ответа)';
}

$uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri    = preg_replace('#^/api/?#', '', $uri);
$parts  = explode('/', trim($uri, '/'));
$route  = $parts[0] ?? '';
$sub    = $parts[1] ?? '';
$id     = isset($parts[1]) && is_numeric($parts[1]) ? (int)$parts[1] : null;
$action = $parts[2] ?? '';

// AUTH ROUTES
if ($route === 'auth') {
    // GET /api/auth/me
    if ($sub === 'me' && method() === 'GET') {
        $u = current_user();
        json_out(['user' => $u ? safe_user($u) : null]);
    }
    // POST /api/auth/register
    if ($sub === 'register' && method() === 'POST') {
        $b = body();
        $username = trim($b['username'] ?? '');
        $password = $b['password'] ?? '';
        if (!preg_match('/^[A-Za-zА-Яа-яЁё0-9_]{3,32}$/u', $username))
            json_err('Ник 3-32 символа: буквы, цифры, _');
        if (strlen($password) < 8)
            json_err('Пароль минимум 8 символов');
        $role   = strtolower($username) === strtolower(OWNER_USERNAME) ? 'owner' : 'pending';
        $active = $role === 'owner' ? 1 : 0;
        try {
            $s = db()->prepare('INSERT INTO app_users(username,password_hash,role,active) VALUES(?,?,?,?)');
            $s->execute([$username, hash_pw($password), $role, $active]);
            $id = db()->lastInsertId();
            $_SESSION['user_id'] = $id;
            json_out(['user' => safe_user(['id'=>$id,'username'=>$username,'role'=>$role,'active'=>$active])], 201);
        } catch (PDOException $e) {
            if ($e->getCode() == 23000) json_err('Такой ник уже зарегистрирован', 409);
            json_err('Ошибка регистрации', 500);
        }
    }
    // POST /api/auth/login
    if ($sub === 'login' && method() === 'POST') {
        $b = body();
        $username = trim($b['username'] ?? '');
        $password = $b['password'] ?? '';
        $s = db()->prepare('SELECT id,username,password_hash,role,active FROM app_users WHERE LOWER(username)=LOWER(?) LIMIT 1');
        $s->execute([$username]);
        $user = $s->fetch();
        if (!$user || !verify_pw($password, $user['password_hash']))
            json_err('Неверный ник или пароль', 401);
        if (strtolower($user['username']) === strtolower(OWNER_USERNAME) && $user['role'] !== 'owner') {
            db()->prepare('UPDATE app_users SET role=?,active=1 WHERE id=?')->execute(['owner',$user['id']]);
            $user['role'] = 'owner'; $user['active'] = 1;
        }
        $_SESSION['user_id'] = $user['id'];
        json_out(['user' => safe_user($user)]);
    }
    // POST /api/auth/logout
    if ($sub === 'logout' && method() === 'POST') {
        session_destroy();
        json_out(['ok' => true]);
    }
    json_err('Неизвестный маршрут', 404);
}

// LOGS ROUTES
if ($route === 'logs') {
    $u = require_user();

    // GET /api/logs — читаем из игровой базы gs336889
    if (method() === 'GET') {
        $category    = trim($_GET['category']    ?? '');
        $subCategory = trim($_GET['subCategory'] ?? '');
        $search      = trim($_GET['search']      ?? '');
        $participant = trim($_GET['participant']  ?? '');
        $date        = trim($_GET['date']         ?? '');

        // Проверка прав для не-владельцев
        $permissions = null;
        if ($u['role'] !== 'owner') {
            $s = db()->prepare('SELECT category, sub_category FROM user_log_permissions WHERE user_id=?');
            $s->execute([$u['id']]);
            $permissions = $s->fetchAll();
            if (empty($permissions)) json_out(['logs' => [], 'permissions' => [], 'categories' => get_game_categories()]);

            // Проверяем, есть ли у пользователя доступ к запрошенной категории
            if ($category !== '') {
                $allowed = false;
                foreach ($permissions as $p) {
                    if ($p['category'] === $category) {
                        if ($subCategory === '' || $p['sub_category'] === null || $p['sub_category'] === $subCategory) {
                            $allowed = true; break;
                        }
                    }
                }
                if (!$allowed) json_out(['logs' => [], 'permissions' => $permissions, 'categories' => get_game_categories()]);
            }
        }

        // Если игровая база не настроена — предупреждение
        if (GAME_DB_HOST === '' || GAME_DB_USER === '') {
            json_out([
                'logs'        => [],
                'permissions' => $permissions,
                'categories'  => get_game_categories(),
                'warning'     => 'Игровая база данных не настроена. Заполни GAME_DB_* в api/config.php',
            ]);
        }

        // Проверяем соединение заранее — чтобы вернуть внятную ошибку
        if (game_db() === null) {
            $errMsg = game_db_error();
            json_out([
                'logs'        => [],
                'permissions' => $permissions,
                'categories'  => get_game_categories(),
                'warning'     => 'Не удалось подключиться к игровой базе данных.' . ($errMsg ? ' Ошибка: ' . $errMsg : ''),
            ]);
        }

        $logs = fetch_game_logs($category, $subCategory, $search, $participant, $date);

        // Фильтрация по правам пользователя
        if ($permissions !== null) {
            $logs = array_values(array_filter($logs, function($log) use ($permissions) {
                foreach ($permissions as $p) {
                    if ($p['category'] === $log['category']) {
                        if ($p['sub_category'] === null || $p['sub_category'] === $log['subCategory']) {
                            return true;
                        }
                    }
                }
                return false;
            }));
        }

        $resp = ['logs' => $logs, 'permissions' => $permissions, 'categories' => get_game_categories()];
        if (!empty($GLOBALS['_fetch_errors'])) {
            $resp['query_errors'] = $GLOBALS['_fetch_errors'];
        }
        json_out($resp);
    }

    // GET /api/logs/categories — список категорий для UI
    if ($sub === 'categories' && method() === 'GET') {
        json_out(['categories' => get_game_categories()]);
    }

    // DELETE /api/logs — очистка (владелец)
    if (method() === 'DELETE') {
        require_owner($u);
        // Игровую базу не трогаем — логируем только в аудит
        db()->prepare('INSERT INTO security_audit_logs(actor_user_id,action,target) VALUES(?,?,?)')->execute([$u['id'],'clear_logs_attempt','game_db_readonly']);
        json_out(['ok' => true, 'message' => 'Игровая база данных доступна только для чтения']);
    }
    json_err('Метод не поддерживается', 405);
}

// USERS ROUTES
if ($route === 'users') {
    $u = require_user();
    require_owner($u);

    // GET /api/users
    if ($id === null && method() === 'GET') {
        $s = db()->query('SELECT u.id, u.username, u.role, u.active, u.created_at AS createdAt FROM app_users u ORDER BY CASE WHEN u.role=\'owner\' THEN 0 ELSE 1 END, u.created_at DESC');
        $users = $s->fetchAll();
        foreach ($users as &$row) {
            $p = db()->prepare('SELECT category, sub_category AS subCategory FROM user_log_permissions WHERE user_id=?');
            $p->execute([$row['id']]);
            $row['permissions'] = $p->fetchAll();
            $row['active']    = (bool)$row['active'];
            $row['protected'] = is_owner_protected($row['username'], $row['role']);
        }
        json_out(['users' => $users]);
    }
    // POST /api/users/:id/activate
    if ($id && $action === 'activate' && method() === 'POST') {
        $s = db()->prepare('SELECT id,username,role FROM app_users WHERE id=?');
        $s->execute([$id]); $row = $s->fetch();
        if (!$row) json_err('Пользователь не найден', 404);
        if (is_owner_protected($row['username'], $row['role'])) json_err('Главного нельзя изменять', 403);
        db()->prepare('UPDATE app_users SET active=1,role=? WHERE id=?')->execute(['viewer',$id]);
        $s = db()->prepare('SELECT id,username,role,active FROM app_users WHERE id=?');
        $s->execute([$id]);
        json_out(['user' => safe_user($s->fetch())]);
    }
    // POST /api/users/:id/deactivate
    if ($id && $action === 'deactivate' && method() === 'POST') {
        if ($u['id'] == $id) json_err('Нельзя отключить самого себя', 403);
        $s = db()->prepare('SELECT id,username,role FROM app_users WHERE id=?');
        $s->execute([$id]); $row = $s->fetch();
        if (!$row) json_err('Пользователь не найден', 404);
        if (is_owner_protected($row['username'], $row['role'])) json_err('Главного нельзя отключить', 403);
        db()->prepare('UPDATE app_users SET active=0,role=? WHERE id=?')->execute(['pending',$id]);
        $s = db()->prepare('SELECT id,username,role,active FROM app_users WHERE id=?');
        $s->execute([$id]);
        json_out(['user' => safe_user($s->fetch())]);
    }
    // PUT /api/users/:id/permissions
    if ($id && $action === 'permissions' && method() === 'PUT') {
        if ($u['id'] == $id) json_err('Нельзя выдавать права самому себе', 403);
        $s = db()->prepare('SELECT id,username,role FROM app_users WHERE id=?');
        $s->execute([$id]); $row = $s->fetch();
        if (!$row) json_err('Пользователь не найден', 404);
        if (is_owner_protected($row['username'], $row['role'])) json_err('Права владельца нельзя менять', 403);
        $perms = body()['permissions'] ?? [];
        db()->prepare('DELETE FROM user_log_permissions WHERE user_id=?')->execute([$id]);
        $ins = db()->prepare('INSERT IGNORE INTO user_log_permissions(user_id,category,sub_category) VALUES(?,?,?)');
        foreach ($perms as $p) {
            $cat = trim($p['category'] ?? '');
            $sub = isset($p['subCategory']) && $p['subCategory'] !== '' ? trim($p['subCategory']) : null;
            if ($cat) $ins->execute([$id, $cat, $sub]);
        }
        json_out(['ok' => true]);
    }
    json_err('Неизвестный маршрут', 404);
}

// RCON ROUTES
if ($route === 'rcon') {
    $u = require_user();
    if ($sub === 'status' && method() === 'GET') json_out(['configured' => rcon_configured()]);
    if ($sub === 'execute' && method() === 'POST') {
        require_owner($u);
        $command = trim(body()['command'] ?? '');
        if (!$command) json_err('Введите RCON-команду');
        if (!rcon_configured()) json_err('RCON не настроен. Заполни api/config.php', 503);
        try {
            $output = rcon_send($command);
            db()->prepare('INSERT INTO security_audit_logs(actor_user_id,action,target) VALUES(?,?,?)')->execute([$u['id'],'rcon_command',$command]);
            json_out(['output' => $output]);
        } catch (RuntimeException $e) {
            json_err($e->getMessage(), 500);
        }
    }
    json_err('Неизвестный маршрут', 404);
}

// SYSTEM STATUS
if ($route === 'system' && $sub === 'status') {
    $u = require_user();
    $gameDbConfigured = GAME_DB_HOST !== '' && GAME_DB_USER !== '';
    $gameDbConnected  = false;
    if ($gameDbConfigured) {
        $gameDbConnected = game_db() !== null;
    }
    json_out([
        'database'                => 'remote',
        'remoteDatabaseConfigured' => true,
        'rconConfigured'           => rcon_configured(),
        'gameDbConfigured'         => $gameDbConfigured,
        'gameDbConnected'          => $gameDbConnected,
    ]);
}

if ($route === 'healthz') json_out(['ok' => true]);

if ($route === 'app' && $sub === 'config') {
    json_out(['name' => APP_NAME, 'title' => APP_TITLE]);
}

json_err('Маршрут не найден', 404);
