/**
 * 手机通知的“广告 / 营销 / 系统噪音”过滤。
 *
 * 用在哪：
 *   - scripts/adb-notify.mjs   电脑端走 adb 收通知，上传前先筛
 *   - src/server.mjs           /api/ingest 兜底再筛一次（老客户端、手动 POST 也不会脏库）
 *   - scripts/clean-notify.mjs 清理早先已经收进来的营销通知
 *   - scripts/phone-notify.mjs Termux 里跑，没有仓库代码，规则是内联副本，改这里记得同步那边
 *
 * 判定顺序（先命中先算）：
 *   1. 重要应用（微信/钉钉/QQ/城院/邮件/日历/短信/支付宝）→ 留；但这些应用里纯促销文案仍会被挡
 *   2. 有人找你（私信/评论/@）→ 留
 *   3. 交易类（订单/快递/验证码/扣款/账单…）→ 留
 *   4. 系统噪音（权限管理服务/正在运行/系统更新…）→ 丢
 *   5. 营销类应用（电商/团购/内容推荐）→ 丢
 *   6. 含促销词（优惠/秒杀/红包/领取…）→ 丢
 *   7. 其它 → 留（宁可多留，不要漏掉真消息）
 */

export const KEEP_PKGS = new Set([
  'com.tencent.mm',            // 微信
  'com.alibaba.android.rimet', // 钉钉
  'com.alibaba.dingtalk',
  'com.tencent.wework',        // 企业微信
  'com.tencent.mobileqq',      // QQ
  'com.tencent.tim',
  'com.hzcu.campus',           // 爱城院
  'com.android.email',
  'com.google.android.gm',
  'com.microsoft.office.outlook',
  'com.android.calendar',
  'com.android.mms',
  'com.eg.android.AlipayGphone', // 支付宝：留，但促销文案仍会按第 6 条挡
]);

export const BLOCK_PKGS = new Set([
  // 电商 / 团购 / 本地生活
  'com.taobao.taobao', 'com.taobao.idlefish', 'com.jingdong.app.mall', 'com.jd.jrapp',
  'com.xunmeng.pinduoduo', 'com.tmall.wireless', 'com.suning.mobile.ebuy', 'com.achievo.vipshop',
  'com.kaola', 'com.dianping.v1', 'com.sankuai.meituan', 'com.sankuai.meituan.takeoutnew',
  'me.ele', 'com.smzdm', 'com.taobao.trip', 'ctrip.android.view', 'com.Qunar',
  // 内容推荐 / 工具类推送
  'com.xingin.xhs', 'com.ss.android.ugc.aweme', 'com.ss.android.article.news', 'com.smile.gifmaker',
  'com.tencent.weishi', 'tv.danmaku.bili', 'com.UCMobile', 'com.autonavi.minimap',
  'com.xt.retouch', 'com.mt.mtxx.mtxx', 'com.luna.music', 'com.kugou.android',
  'com.netease.cloudmusic', 'com.tencent.qqmusic', 'com.ximalaya.ting.android',
  // 厂商商城 / 应用商店
  'com.xiaomi.shop', 'com.huawei.appmarket', 'com.heytap.market', 'com.oppo.market',
  'com.bbk.appstore', 'com.tencent.android.qqdownloader', 'com.qihoo.appstore',
  'com.shizhuang.duapp',
]);

// 只有应用显示名时的兜底（老数据 / 没有 pkg 的通知）
export const KEEP_NAMES = new Set(['微信', '钉钉', '企业微信', 'QQ', 'TIM', '爱城院', '邮件', '日历', '短信', '支付宝']);

export const BLOCK_NAMES = new Set([
  '淘宝', '京东', '京东金融', '拼多多', '天猫', '苏宁', '唯品会', '闲鱼', '考拉', '大众点评',
  '美团', '饿了么', '高德地图', '小红书', '抖音', '快手', '今日头条', '微博', '哔哩哔哩',
  '网易云音乐', 'QQ音乐', '酷狗音乐', '喜马拉雅', '什么值得买', '美颜相机', '美图秀秀', '携程', '去哪儿',
  '小米商城', '华为商城', '应用商店', '应用宝', '得物', '得物App',
]);

export const NOISE_RE = /(权限管理服务|正在运行|后台运行|前台服务|系统更新|发现新版本|充电中|快充|极致加速|电量低|存储空间|安全中心|垃圾清理|加速球|已连接|已断开|连接成功|网络不可用|无线调试|应用接力|设备已连接|Wake with voice|Continuity|Device interconnectivity)/;
export const KEEP_MSG_RE = /(私信|发来消息|回复了你|评论了你|@了你|提到了你|好友申请|群消息|有人@|向你发起了)/;
export const TRANSACTION_RE = /(您的订单|订单号|已发货|已签收|派送中|派件|取件码|快递|包裹|退款|退货|验证码|动态码|扣款|扣费|支付成功|已支付|账单|还款|转账|入账|支出|消费金额|余额变动|到账提醒)/;
export const PROMO_RE = /(优惠|特价|秒杀|限量|限时|抢购|大促|满减|折扣|红包|抽奖|福利|礼包|好礼|领取|免费|包邮|种草|必吃|好物|精选|推荐|上新|会员日|签到|积分|返现|补贴|清仓|低至|起购|业绩比较基准|理财|试听|直播|砍价|拼单|首单|专属|特权|幸运|资格|速来|倒计时|立即使用)/;

function textOf(n) {
  return [n.title, n.text].filter(Boolean).join(' ').trim();
}

const PROMO_G = new RegExp(PROMO_RE.source, 'g');
function promoHits(t) {
  return (t.match(PROMO_G) || []).length;
}

/**
 * @param {{pkg?:string, app?:string, title?:string, text?:string}} n
 * @param {{filterAds?:boolean, keepPkgs?:string[], blockPkgs?:string[], extraKeep?:string, extraBlock?:string}} [opts]
 * @returns {{ad:boolean, reason:string}}
 */
export function classifyNotification(n, opts = {}) {
  if (opts.filterAds === false) return { ad: false, reason: '' };
  const pkg = String(n.pkg || '');
  const app = String(n.app || '');
  const t = textOf(n);
  if (!t) return { ad: false, reason: '' };

  const keepPkgs = opts.keepPkgs || [];
  const blockPkgs = opts.blockPkgs || [];
  const trusted = KEEP_PKGS.has(pkg) || KEEP_NAMES.has(app) || keepPkgs.includes(pkg) || keepPkgs.includes(app);
  const msg = KEEP_MSG_RE.test(t);
  const trans = TRANSACTION_RE.test(t);

  if (trusted) {
    // 重要应用基本都留；只有“通篇营销”的才挡（支付宝理财推广之类）。
    // 单个促销词不算——群里有人说“签到码”不能因此被当成广告。
    if (!msg && !trans && promoHits(t) >= 2) return { ad: true, reason: '重要应用里的营销推送' };
    return { ad: false, reason: '重要应用' };
  }
  if (msg) return { ad: false, reason: '有人找' };
  if (trans) return { ad: false, reason: '交易/物流' };
  if (NOISE_RE.test(t)) return { ad: true, reason: '系统噪音' };
  const blockByCfg = blockPkgs.includes(pkg) || blockPkgs.includes(app);
  const blockApp = BLOCK_PKGS.has(pkg) || BLOCK_NAMES.has(app) || blockByCfg;
  const promo = PROMO_RE.test(t);
  if (blockApp) return { ad: true, reason: promo ? '营销应用 + 促销词' : '营销/内容推荐应用' };
  if (promo) return { ad: true, reason: '促销词' };
  if (opts.extraBlock && new RegExp(opts.extraBlock).test(t)) return { ad: true, reason: '自定义屏蔽' };
  return { ad: false, reason: '' };
}
