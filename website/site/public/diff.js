// The animated comparison on tegami.chat: typical apps on the left, Tegami on the right.
// Built from the draft Tegamiの違いのアニメーション案. data-mode="dev" on #diff shows the developer wording.
// ─── 言葉 ───────────────────────────────────────────
const JA = {
  'ctl.pause': '一時停止', 'ctl.play': '再生',
  'for.general': '一般向け', 'for.dev': '技術者向け', 'diff.h': 'よくあるアプリとの違い',
  'ty': 'よくあるアプリ', 'you': 'あなた', 'friend': '相手',
  'srv.ty': '運営会社のサーバー', 'srv.tg': 'Tegamiのサーバー',

  'seal.chip': 'メッセージの中身', 'seal.h': '送る前に封をする。',
  'seal.t': 'よくあるアプリは、誰にいつ送ったか、何を押したかを記録し、広告に使います。Tegamiは送る前に端末の中で封をするので、サーバーは中身を読めないまま相手に届けます。',
  'seal.r1': '電話番号', 'seal.r2': '送った相手と時刻', 'seal.r3': '押した広告', 'ad': '広告',
  'seal.lock': '中身は読めない', 'seal.del': '30日後に削除',
  'seal.ty1': 'メッセージは運営会社のサーバーを通って届く', 'seal.ty2': 'サーバーは電話番号、送った相手と時刻、押した広告を記録する', 'seal.ty3': 'その記録をもとにトーク一覧に広告が出る',
  'seal.tg1': '端末の中でメッセージに封をする', 'seal.tg2': 'サーバーは封を開けられないまま相手に届ける', 'seal.tg3': 'サーバーの封筒は30日後に消え、会話は端末に残る',

  'ads.chip': '広告とニュース', 'ads.h': 'トーク一覧はトークだけ。',
  'ads.t': '開いた瞬間の広告も、余計なニュースやショッピングのタブもありません。',
  'ads.talk': 'トーク', 'ads.news': 'ニュース',
  'ads.ty1': 'トーク一覧の一番上に広告が出る', 'ads.ty2': '下のタブにニュースやショッピングが並ぶ', 'ads.ty3': '押し間違えると見たくない画面が開く',
  'ads.tg1': '一覧に並ぶのはトークだけ', 'ads.tg2': '画面の上にある切り替えはトークと友だちの2つだけ', 'ads.tg3': '話したい相手のトークをそのまま開ける',

  'num.chip': '電話番号', 'num.h': '電話番号はいらない。',
  'num.t': 'Tegamiのアカウントは、あなたの端末の中で作る鍵です。電話番号もメールアドレスも渡しません。',
  'num.pill': 'a7f3…', 'num.label': '電話番号', 'num.next': '次へ', 'num.start': 'はじめる', 'num.acc': 'アカウント', 'num.id': '名前のないID',
  'num.ty1': '始めるには電話番号の入力が必要', 'num.ty2': '入力した番号が運営会社のサーバーに送られる', 'num.ty3': '番号とアカウントが結びついて記録される',
  'num.tg1': '電話番号もメールアドレスも入力しない', 'num.tg2': '鍵は端末の中で作られ、パスキーで守られる', 'num.tg3': 'サーバーに届くのは、電話番号とも名前とも無関係なID',

  'pw.chip': '乗っ取り', 'pw.h': '盗まれるパスワードがない。',
  'pw.t': 'Tegamiはパスワードを使いません。顔や指紋で開くパスキーなので、偽のページにだまされて入力してしまう心配もありません。',
  'pw.label': 'パスワード', 'pw.login': 'ログイン', 'pw.fake': '偽のページ', 'pw.thief': '乗っ取る人', 'pw.in': '乗っ取られた',
  'pw.ty1': 'パスワードを入力してログインする', 'pw.ty2': '偽のページなどで盗まれてしまう', 'pw.ty3': '盗んだ人があなたのアカウントにログインできてしまう',
  'pw.tg1': '顔や指紋でロックを解除する。パスワードはない', 'pw.tg2': '盗もうとしても、盗めるものがない', 'pw.tg3': '鍵はあなたの端末にあり、偽のページからは開けない',

  'leak.chip': '情報の流出', 'leak.h': '漏れても中身は読めない。',
  'leak.t': 'どんなサービスでも、サーバーが不正アクセスを受ける可能性はあります。Tegamiのサーバーに置かれるメッセージは、封をしたままです。',
  'leak.r1': '電話番号', 'leak.r2': '名前', 'leak.r3': '友だち一覧', 'leak.out': '盗んだ人', 'leak.no': '開けられない',
  'leak.ty1': '運営会社のサーバーに多くの人の情報が集まる', 'leak.ty2': 'サーバーが不正アクセスを受ける', 'leak.ty3': '電話番号や名前が読める形のまま外に漏れる',
  'leak.tg1': 'サーバーに置かれるメッセージは封をしたまま', 'leak.tg2': 'サーバーが不正アクセスを受ける', 'leak.tg3': '封筒を持ち出されても、鍵がなければ開けられない',

  'trk.chip': '行動の記録', 'trk.h': '何を押したか記録しない。',
  'trk.t': 'Tegamiには、何を押したか、何を見たかを追いかける仕組みがありません。サーバーが数えるのは全体の合計だけで、公開しているのも誰のものか分からない週ごとの集計です。',
  'trk.r1': '押したもの', 'trk.r2': '見たページ', 'trk.r3': '見ていた時間', 'trk.int': '興味の分析',
  'trk.count': '先週届いた総数', 'trk.pub': '週ごとの合計を公開',
  'trk.ty1': '押したものや見た画面が送られる', 'trk.ty2': 'サーバーがあなたの操作を記録する', 'trk.ty3': 'その記録からあなたの興味が分析される',
  'trk.tg1': '画面を操作しても、その記録は送られない', 'trk.tg2': 'サーバーが数えるのは日ごとの全体件数だけ', 'trk.tg3': '公開しているのは、終わった週の合計を丸めた数字だけ',

  'ai.chip': 'AI', 'ai.h': '使うAIは自分で選ぶ。',
  'ai.t': '運営会社が組み込んだAIではなく、あなたが選んだAIを、あなたのPCからつないで使います。トークにAIを呼ぶ時は、全員に確認します（準備中）。',
  'ai.co': '運営会社のAI', 'ai.pc': 'あなたのPCのAI', 'ai.r1': 'あなたの発言', 'ai.r2': '相手の発言', 'ai.ask': 'AIを入れる？', 'ai.yes': 'はい',
  'ai.ty1': 'アプリに組み込まれた運営会社のAIを使う', 'ai.ty2': 'AIを使うと、相手のメッセージも運営会社に送られる', 'ai.ty3': '相手への確認はない',
  'ai.tg1': 'あなたが選んだAIを手元のPCからつないで動かす', 'ai.tg2': 'トークにAIを呼ぶ前に、全員に確認する（準備中）', 'ai.tg3': 'あなたのAIが読めるのは許可したトークだけ',
};
const ENS = {
  'ctl.pause': 'Pause', 'ctl.play': 'Play',
  'for.general': 'General', 'for.dev': 'Developers', 'diff.h': 'How Tegami is different',
  'ty': 'Typical apps', 'you': 'You', 'friend': 'Friend',
  'srv.ty': 'Company server', 'srv.tg': 'Tegami server',

  'seal.chip': 'Your messages', 'seal.h': 'Sealed before it leaves.',
  'seal.t': 'Typical apps record who you message, when, and what you tap, and use it for ads. Tegami seals each message on your device before sending, so the server delivers it without being able to open it.',
  'seal.r1': 'Phone number', 'seal.r2': 'Who and when', 'seal.r3': 'Ads you tapped', 'ad': 'Ad',
  'seal.lock': "Can't open it", 'seal.del': 'Deleted after 30 days',
  'seal.ty1': "Your message passes through the company's server.", 'seal.ty2': 'The server records your phone number, who you messaged and when, and the ads you tapped.', 'seal.ty3': 'That record is used to put ads in your chat list.',
  'seal.tg1': 'Your device seals the message in an envelope.', 'seal.tg2': "The server can't open the envelope. It only passes it on.", 'seal.tg3': 'The server deletes the envelope after 30 days. Your chats stay on your devices.',

  'ads.chip': 'Ads and news', 'ads.h': 'Your chat list is just chats.',
  'ads.t': "No ad when you open the app, no news you didn't ask for, no shopping tab.",
  'ads.talk': 'Chats', 'ads.news': 'News',
  'ads.ty1': 'An ad sits at the top of your chat list.', 'ads.ty2': 'The bottom tabs are filled with news and shopping.', 'ads.ty3': 'One wrong tap opens a screen you didn\'t want.',
  'ads.tg1': 'Your chat list shows only chats.', 'ads.tg2': 'At the top, you only switch between Chats and Friends.', 'ads.tg3': 'You open straight into the person you want to talk to.',

  'num.chip': 'Phone number', 'num.h': 'No phone number needed.',
  'num.t': 'Your Tegami account is a key made on your own device. You never hand over a phone number or email.',
  'num.pill': 'a7f3…', 'num.label': 'Phone number', 'num.next': 'Next', 'num.start': 'Start', 'num.acc': 'Account', 'num.id': 'ID with no name',
  'num.ty1': 'You need a phone number to sign up.', 'num.ty2': 'The number you entered is sent to the company\'s server.', 'num.ty3': 'Your number and account are linked and stored.',
  'num.tg1': 'No phone number, no email.', 'num.tg2': 'A key is made on your device and protected by a passkey.', 'num.tg3': 'The server receives only an ID with no phone number or name.',

  'pw.chip': 'Account takeover', 'pw.h': 'No password to steal.',
  'pw.t': 'Tegami doesn\'t use passwords. You unlock it with a passkey using your face or fingerprint, so a fake page can\'t trick you into typing one.',
  'pw.label': 'Password', 'pw.login': 'Log in', 'pw.fake': 'Fake page', 'pw.thief': 'Impostor', 'pw.in': 'Taken over',
  'pw.ty1': 'You log in with a password.', 'pw.ty2': 'It gets stolen through a fake page.', 'pw.ty3': 'The impostor can log in as you.',
  'pw.tg1': 'Unlock with your face or fingerprint. No password.', 'pw.tg2': 'Even if someone tries, there\'s nothing to steal.', 'pw.tg3': 'Your key stays on your device, and a fake page cannot open it.',

  'leak.chip': 'Data leaks', 'leak.h': "Leaked, but unreadable.",
  'leak.t': "Any service can be breached. Messages on Tegami's server stay sealed.",
  'leak.r1': 'Phone numbers', 'leak.r2': 'Names', 'leak.r3': 'Friend lists', 'leak.out': 'Attacker', 'leak.no': "Can't be opened",
  'leak.ty1': "Lots of people's data piles up on the company's server.", 'leak.ty2': 'The server is breached.', 'leak.ty3': 'Phone numbers and names leak out in readable form.',
  'leak.tg1': "Messages on the server stay sealed.", 'leak.tg2': 'The server is breached.', 'leak.tg3': 'Even if the envelopes are stolen, they can\'t be opened without the key.',

  'trk.chip': 'Tracking', 'trk.h': "We don't record what you tap.",
  'trk.t': 'Tegami has nothing that follows what you tap or view. The server only counts overall totals, and only anonymized weekly summaries are made public.',
  'trk.r1': 'What you tapped', 'trk.r2': 'Pages you saw', 'trk.r3': 'Time spent', 'trk.int': 'Your interests',
  'trk.count': 'Delivered last week', 'trk.pub': 'Public by week',
  'trk.ty1': 'What you tap and view is sent off.', 'trk.ty2': 'The server records everything you do.', 'trk.ty3': 'Your interests are analyzed from that record.',
  'trk.tg1': 'Tap anything. No tracking data is sent.', 'trk.tg2': 'The server counts only overall daily totals.', 'trk.tg3': 'Only rounded totals for completed weeks are made public.',

  'ai.chip': 'AI', 'ai.h': 'You choose your AI.',
  'ai.t': 'Not a company\'s AI built into the app, but an AI you choose, connected from your own computer. Before AI joins a chat, everyone is asked (coming soon).',
  'ai.co': "Company's AI", 'ai.pc': 'AI on your PC', 'ai.r1': 'Your messages', 'ai.r2': "Friend's messages", 'ai.ask': 'Add AI?', 'ai.yes': 'Yes',
  'ai.ty1': "You use the company's AI built into the app.", 'ai.ty2': "Your friend's messages go to the company too.", 'ai.ty3': "Your friend isn't asked.",
  'ai.tg1': 'The AI you choose connects from your own computer.', 'ai.tg2': 'Before AI joins a chat, everyone is asked (coming soon).', 'ai.tg3': 'Your AI reads only the chats you allow.',
};

// 技術者向けの言葉。ここに無い言葉は一般向けの言葉を使う。
const JA_DEV = {
  'diff.h': 'よくある構成との違い',
  'ty': 'よくある構成',
  'srv.ty': 'APIサーバー', 'srv.tg': 'Tegamiリレー',

  'seal.h': 'NIP-17で封をしてから送る。',
  'seal.t': '一般的なアプリのサーバーは送信者、受信者、時刻をデータベースに記録します。Tegamiはrumor（kind 14または15）をNIP-44で暗号化し、送信者が署名した内側の層（kind 13）に収めます。さらに使い捨ての鍵で再びNIP-44による暗号化と署名をして、封筒（NIP-59 の gift wrap。暗号化したメッセージを入れた入れ物。kind 1059）で包みます。1対1では宛先用と自分用の控えの2通を送ります。',
  'seal.r1': 'ユーザーID', 'seal.r2': '送信者、受信者、時刻', 'seal.r3': '広告イベント',
  'seal.lock': '中身はNIP-44', 'seal.del': '30日後に削除',
  'seal.ty1': 'メッセージはTLS（アプリによってはE2EE）でAPIサーバーに届く', 'seal.ty2': 'サーバーが送信者、受信者、時刻をデータベースに残す', 'seal.ty3': 'そのイベントログが広告配信に使われる',
  'seal.tg1': '端末内でメッセージをNIP-44で暗号化し、内側の層と封筒で2重に包む', 'seal.tg2': 'リレーはNIP-42で認証済みの鍵に対し、pタグが一致するkind 1059だけを返す', 'seal.tg3': 'リレーは30日後に封筒を削除し、履歴は利用者の端末に残る',
  'seal.spec': '使用仕様：NIP-17、NIP-44、NIP-59、NIP-42。内側の層と封筒のcreated_atは最大2日前にずらします（nostr-toolsのNIP-59実装）。限界：書き込みにもNIP-42認証と事前登録が必要なため、リレーは送信元の公開鍵、宛先の公開鍵、到着時刻、IPアドレスを結びつけられます。NIP-44は同じ鍵を使い続けるため、前方秘匿性はありません。',

  'ads.h': 'トラッカーも広告SDKも入っていない。',
  'ads.t': 'Web版はCSPにより、読み込めるスクリプトを自身のオリジンと、新規登録時の人間確認に使うCloudflare Turnstileだけに限っています。広告や解析のスクリプトはありません。',
  'ads.ty1': 'リモート設定でトーク一覧に広告枠が差し込まれる', 'ads.ty2': 'タブにニュースやコマースへの導線が並ぶ', 'ads.ty3': '誤タップもクリックとして計測される',
  'ads.tg1': 'トーク一覧には端末に保存した会話だけを表示する', 'ads.tg2': '切り替えは「トーク」と「友だち」の2つだけ。広告や余分な画面をリモート設定で差し込む仕組みはない', 'ads.tg3': 'タップや画面表示を計測イベントとして送信しない',
  'ads.spec': 'CSP：script-src \'self\' https://challenges.cloudflare.com。connect-srcは自身のオリジンとリレーだけです。Cloudflare Web Analytics（RUM）は無効です。そのほか外部へ出る通信は、リレー経由のファイルストレージ（R2）、通話用のSTUN（stun.cloudflare.com）、Web Pushサービスです。',

  'num.h': '電話番号ではなくsecp256k1の鍵。',
  'num.t': 'アカウントは端末で生成するNostrの鍵ペアです。秘密鍵はWebAuthnのPRF拡張の出力から作ったAES-GCM鍵で暗号化し、端末内に保存します。',
  'num.acc': 'ユーザーID', 'num.id': 'npub（公開鍵）', 'num.pill': 'npub1…',
  'num.ty1': 'SMSの認証コードで電話番号を確かめる', 'num.ty2': '番号がサーバーのユーザーテーブルに登録される', 'num.ty3': 'その番号がアカウントに紐づけられる',
  'num.tg1': '端末で鍵ペアを生成する', 'num.tg2': '秘密鍵はPRFの出力から作ったAES-GCM鍵で暗号化し、端末内に保存する', 'num.tg3': 'NIP-98で署名したリクエストで公開鍵をリレーに登録する',
  'num.spec': '使用仕様：Nostrの鍵（secp256k1、Schnorr署名）、WebAuthnのPRF拡張、HKDF、AES-GCM、NIP-98。登録には招待コードかCloudflare Turnstileを使い、誰が誰を招待したかの記録は90日で消去します。PRF拡張に非対応の認証器では、エクスポートできないAES鍵をIndexedDBに保存します。',

  'pw.h': 'ログインのパスワードがそもそもない。',
  'pw.t': '秘密鍵（nsec）は端末で生成し、WebAuthnのPRF拡張の出力から作った鍵で暗号化してオリジンごとの保存領域に置きます。パスキーはオリジンに紐づくため、偽のドメインではPRFの出力が得られず復号できません。',
  'pw.fake': '偽のドメイン', 'pw.thief': '攻撃者', 'pw.in': 'セッション奪取',
  'pw.ty1': 'パスワードとSMSのワンタイムコードでログインする', 'pw.ty2': '中継型フィッシングで両方を横取りされる', 'pw.ty3': '攻撃者がセッションを手に入れる',
  'pw.tg1': '端末に保存したnsecをパスキーで復号する', 'pw.tg2': '偽のドメインではPRFの出力が得られず、復号できない', 'pw.tg3': 'nsecはサーバーに送信しない',
  'pw.spec': '使用仕様：WebAuthnのPRF拡張、HKDF、AES-GCM。限界：復号した秘密鍵はブラウザのメモリ上で署名に使うため、XSSや配信JavaScriptの改ざんには弱いです。PRF拡張に非対応の認証器では、エクスポートできないAES鍵をIndexedDBに保存します。復旧コードは偽サイトに入力させる手口で盗まれるおそれがあります。',

  'leak.h': 'ダンプされても、チャットは暗号文のまま。',
  'leak.t': 'リレーのデータベースに保存されるメッセージは封筒の暗号文です。写真やファイルも個別の鍵を使い、AES-GCMで暗号化してからストレージにアップロードします。',
  'leak.r1': '電話番号', 'leak.r2': 'プロフィール', 'leak.r3': '連絡先一覧', 'leak.out': '攻撃者', 'leak.no': '鍵がない',
  'leak.ty1': 'データベースに個人情報がまとまって入っている', 'leak.ty2': 'データベースが外に持ち出される', 'leak.ty3': '電話番号やプロフィールが平文のまま読まれる',
  'leak.tg1': 'データベースのメッセージはkind 1059の暗号文', 'leak.tg2': 'データベースが外に持ち出される', 'leak.tg3': '持ち出されても、受信者の秘密鍵がなければ復号できない',
  'leak.spec': '持ち出される可能性があるもの：宛先の公開鍵（pタグ）、到着時刻、登録済みの公開鍵と招待関係（90日保持）、Web Pushのエンドポイントと鍵、暗号化した復旧用バックアップ、R2の暗号化ファイルとスタンプ（サイズ、SHA-256、保持者情報を含む）、通報記録（通報者と相手の公開鍵、理由、添付された場合は直近メッセージの平文を90日保持）。持ち出されても読めないもの：通常のメッセージ、写真、ファイル、スタンプ、バックアップの平文。',

  'trk.h': 'イベントを計測していない。',
  'trk.t': 'アプリに解析SDKはありません。リレーは日ごとの全体件数を183日保持して運営者向けに集計し、終わった週の合計だけを直近24週分、外部公開しています（https://relay.tegami.chat/stats、https://tegami.chat/status）。',
  'trk.r1': 'タップ', 'trk.r2': '画面表示', 'trk.r3': '滞在時間', 'trk.int': 'セグメント',
  'trk.count': '先週受け付けた封筒', 'trk.pub': '/statsで公開',
  'trk.ty1': '解析SDKがタップや画面表示をイベントとして送る', 'trk.ty2': 'イベントがユーザーIDごとに保存される', 'trk.ty3': 'その記録から興味のセグメントが作られる',
  'trk.tg1': 'クライアントは操作イベントを送らない', 'trk.tg2': 'リレーは日ごとの全体件数だけを内部で数え、アクティブ鍵数の概算には日替わりの秘密の値とHyperLogLogを使う', 'trk.tg3': '公開するのは終わった週の合計（0から9は0、10以上は10の倍数に切り上げ）と1日平均の鍵数のみ',
  'trk.spec': 'Workersのinvocation logsは無効です。利用者が許可したクラッシュ報告などの出力（console.log）はWorkers Logsに数日残ります。日ごとの集計は183日で削除し、運営者のみ閲覧できます。公開ページ（https://relay.tegami.chat/stats、https://tegami.chat/status）には、終わった週（UTCの月曜始まり）を直近24週分だけ出します。',

  'ai.h': 'AIは自分の鍵を持つ相手。',
  'ai.t': 'tegami-agentはPC上で独自のNostr鍵を持ち、人間と同じNIP-17でやり取りします。AIの契約やAPIキーをTegamiのサーバーに渡すことはありません。AIに読ませた内容は手元のclaude -pなどを通じてAI提供元に送られます。またtegami-agentはMCPサーバーとしても動作します。',
  'ai.pc': 'tegami-agent（PC）', 'ai.r1': '自分の発言', 'ai.r2': '相手の発言',
  'ai.ty1': 'アプリに組み込まれたAI機能を使う', 'ai.ty2': '相手の発言を含むトーク履歴が提供元のAPIに送られる', 'ai.ty3': '相手の同意は求められない',
  'ai.tg1': 'tegami-agentがPC上で動き、手元のClaude Codeなどを呼ぶ', 'ai.tg2': 'トークにAIを呼ぶ前に、全員の同意を求める（準備中）', 'ai.tg3': 'AIの権限は4段（AIの使用、AIモデル、AI友だち、友だち）で制御し、判断はすべて端末に記録する',
  'ai.spec': 'AIとの会話もNIP-17の封筒です。トークの全員の同意を求める仕組みと、相手が「自分の文を相手のAIに読ませない」を選べる仕組みは実装済みですが、本番にはまだ出していません（初期設定は無効）。受信者が自分の端末で復号した発言をAIに渡す行為までは、暗号の仕組みでは防げません。',
  'terms.h': '用語の説明',
};
const EN_DEV = {
  'diff.h': 'How Tegami differs from the usual stack',
  'ty': 'Typical stack',
  'srv.ty': 'API server', 'srv.tg': 'Tegami relay',

  'seal.h': 'Gift-wrapped with NIP-17.',
  'seal.t': 'A typical server stores sender, recipient and timestamp in its database. Tegami encrypts the rumor (kind 14 or 15) with NIP-44 into a seal (kind 13) signed by the sender, then encrypts and signs that with a one-time key into a gift wrap (kind 1059). For a 1:1 chat, two copies go out: one for the recipient and one for the sender.',
  'seal.r1': 'User ID', 'seal.r2': 'Sender, recipient, time', 'seal.r3': 'Ad events',
  'seal.lock': 'NIP-44 inside', 'seal.del': 'Deleted after 30 days',
  'seal.ty1': 'The message reaches the API server over TLS (E2EE in some apps).', 'seal.ty2': 'The server stores sender, recipient and time in its database.', 'seal.ty3': 'Event logs feed ad delivery.',
  'seal.tg1': 'The device encrypts with NIP-44 and wraps it twice: seal, then gift wrap.', 'seal.tg2': 'The relay serves kind 1059 only to a NIP-42 authenticated key that matches its p tag.', 'seal.tg3': 'The relay deletes the envelope after 30 days. History stays on your devices.',
  'seal.spec': 'Specs: NIP-17, NIP-44, NIP-59, NIP-42. created_at of the seal and gift wrap is shifted up to two days back (nostr-tools\' NIP-59). Limits: writing also requires NIP-42 AUTH and registration, so the relay can link the writer\'s pubkey, the recipient pubkey, arrival time and IP. NIP-44 uses static keys, so there is no forward secrecy.',

  'ads.h': 'No trackers. No ad SDK.',
  'ads.t': 'The web app limits scripts by CSP to its own origin and Cloudflare Turnstile (the human check at sign-up). No ad or analytics scripts.',
  'ads.ty1': 'Remote config injects an ad slot into the chat list.', 'ads.ty2': 'Tabs funnel you to news and commerce.', 'ads.ty3': 'Even a mistap is measured as a click.',
  'ads.tg1': 'The chat list is drawn only from chats stored on the device.', 'ads.tg2': 'Only Chats and Friends switchers. No remote config to inject ads or extra tabs.', 'ads.tg3': 'Taps and screen views are not sent as telemetry.',
  'ads.spec': 'CSP: script-src \'self\' https://challenges.cloudflare.com. connect-src is limited to its own origin and the relay. Cloudflare Web Analytics (RUM) is off. Other outbound traffic: file storage via the relay (R2), STUN for calls (stun.cloudflare.com), and Web Push services.',

  'num.h': 'A secp256k1 key, not a phone number.',
  'num.t': 'An account is a Nostr key pair generated on the device. The secret key is encrypted with an AES-GCM key derived from the WebAuthn PRF extension and stored on the device.',
  'num.acc': 'User ID', 'num.id': 'npub (public key)', 'num.pill': 'npub1…',
  'num.ty1': 'An SMS code verifies your phone number.', 'num.ty2': "Your number goes into the server's user table.", 'num.ty3': 'Your phone number is linked to your account.',
  'num.tg1': 'The device generates a key pair.', 'num.tg2': 'The secret key is encrypted with an AES-GCM key from PRF.', 'num.tg3': 'A NIP-98 signed request registers the public key with the relay.',
  'num.spec': 'Specs: Nostr keys (secp256k1, Schnorr), WebAuthn PRF, HKDF, AES-GCM, NIP-98. Registration uses an invite code or Cloudflare Turnstile; who invited whom is deleted after 90 days. When the authenticator does not support PRF, a non-extractable AES key is kept in IndexedDB.',

  'pw.h': 'There is no login password at all.',
  'pw.t': 'The secret key (nsec) is generated on the device, encrypted with a key derived from the WebAuthn PRF extension, and stored in the origin\'s storage. Passkeys are origin-bound, so a fake domain gets no PRF output and cannot decrypt the nsec.',
  'pw.fake': 'Fake domain', 'pw.thief': 'Attacker', 'pw.in': 'Session hijacked',
  'pw.ty1': 'You log in with a password and an SMS one-time code.', 'pw.ty2': 'An adversary-in-the-middle page relays both.', 'pw.ty3': 'The attacker gets your session.',
  'pw.tg1': 'A passkey decrypts the nsec stored on the device.', 'pw.tg2': 'On a fake domain there is no PRF output, so the nsec stays encrypted.', 'pw.tg3': 'The nsec is never sent to the server.',
  'pw.spec': 'Specs: WebAuthn PRF, HKDF, AES-GCM. Limits: the decrypted secret key is used for signing in browser memory, so XSS or tampered JavaScript would expose it. Without PRF support, a non-extractable AES key in IndexedDB is used. A recovery code can be phished by a fake page.',

  'leak.h': 'Dumped, but chats stay encrypted.',
  'leak.t': "The relay database holds gift-wrap ciphertext. Photos and files are encrypted with a per-file AES-GCM key before upload.",
  'leak.r1': 'Phone numbers', 'leak.r2': 'Profiles', 'leak.r3': 'Contact lists', 'leak.out': 'Attacker', 'leak.no': 'No key',
  'leak.ty1': 'Personal data sits together in one database.', 'leak.ty2': 'The database is exfiltrated.', 'leak.ty3': 'Phone numbers and profiles are readable as is.',
  'leak.tg1': 'Messages in the database are kind 1059 ciphertext.', 'leak.tg2': 'The database is exfiltrated.', 'leak.tg3': 'Even if stolen, nothing decrypts without the recipient\'s secret key.',
  'leak.spec': 'Could leak: recipient pubkeys (p tags), arrival times, registered pubkeys and invite links between keys (kept 90 days), Web Push endpoints and keys, encrypted recovery backups, encrypted R2 files and stamps (with sizes, SHA-256, and stamp keepers), and abuse reports (reporter and reported pubkeys, reason, and plaintext recent messages for 90 days if attached by the reporter). Cannot be read: plaintext of normal messages, photos, files, stamps and backups.',

  'trk.h': 'No event tracking.',
  'trk.t': 'The app has no analytics SDK. The relay keeps daily overall aggregates for 183 days for the operator, and publishes only completed weekly totals for the last 24 weeks (https://relay.tegami.chat/stats, https://tegami.chat/status).',
  'trk.r1': 'Taps', 'trk.r2': 'Screen views', 'trk.r3': 'Dwell time', 'trk.int': 'Segments',
  'trk.count': 'Envelopes last week', 'trk.pub': 'Public at /stats',
  'trk.ty1': 'An analytics SDK sends taps and views as events.', 'trk.ty2': 'Events are stored per user ID.', 'trk.ty3': 'Interest segments are built from events.',
  'trk.tg1': 'The client sends no interaction events.', 'trk.tg2': 'The relay counts only daily aggregates internally, estimating active keys with HyperLogLog and a per-day secret discarded when the day ends.', 'trk.tg3': 'Only completed weekly totals (0–9 as 0, rounded up to multiples of 10) and daily-average key counts are published.',
  'trk.spec': 'Workers invocation logs are off. Opt-in crash reports and error output (console.log) stay in Workers Logs for a few days. Daily aggregates are deleted after 183 days and are visible only to the operator. Public /stats and https://tegami.chat/status show only the last 24 completed weeks (Monday-start UTC).',

  'ai.h': 'AI is a peer with its own key.',
  'ai.t': 'tegami-agent holds its own Nostr key on your PC and talks over NIP-17 like any person. Your AI subscription and API keys are never handed to Tegami. Whatever the AI reads is sent to the AI provider by your local claude -p or similar. It also runs as an MCP server.',
  'ai.pc': 'tegami-agent (PC)', 'ai.r1': 'Your messages', 'ai.r2': "Friend's messages",
  'ai.ty1': 'You use the AI built into the app.', 'ai.ty2': "Chat history, including your friend's messages, goes to the vendor's API.", 'ai.ty3': "Your friend's consent isn't asked.",
  'ai.tg1': 'tegami-agent runs on your PC and calls local tools such as Claude Code.', 'ai.tg2': 'Before AI joins a chat, everyone is asked for consent (built, not yet released).', 'ai.tg3': 'AI permissions have four layers (AI use, AI model, AI friend, friend), and every decision is logged on the device.',
  'ai.spec': 'Chats with AI are NIP-17 gift wraps too. Asking everyone in the chat for consent and letting a partner opt out of having their messages read by the other side\'s AI are built, but not yet released to production (off by default). Cryptography can\'t stop a recipient from passing messages they decrypted to their own AI.',
  'terms.h': 'Terms',
};
const root = document.getElementById('diff');
const lang = document.documentElement.lang === 'ja' ? 'ja' : 'en';
const dev = root.dataset.mode === 'dev';
const t = (k) => (dev ? (lang === 'ja' ? JA_DEV : EN_DEV)[k] : null) ?? (lang === 'ja' ? JA : ENS)[k] ?? k;
// 技術者向けの場面の下に出す用語の説明。[用語, 説明] の組
const TERMS = {"ja": {"seal": [["APIサーバー", "クライアントからのリクエストを処理し、データ保存やメッセージ中継を一括して担う中央サーバーです。"], ["リレー", "Nostrプロトコルにおいて、クライアントが送ったイベントを受信して保持し、条件に合うクライアントへ配信するサーバーです。"], ["NIP-17", "Nostrにおける非公開ダイレクトメッセージの仕様です（NIPはNostrの仕様提案番号）。"], ["rumor", "Nostrの暗号化メッセージにおいて、送信者の署名を付けない状態の生のイベントデータ（テキストのkind 14やファイルのkind 15）です。"], ["kind", "Nostrのイベントデータに含まれ、イベントの種別を識別するための整数値です。"], ["NIP-44", "送信者と受信者の鍵から共有鍵を作ってデータを暗号化する、Nostrの認証付き暗号仕様です。"], ["seal", "rumorをNIP-44で暗号化し、送信者の秘密鍵で署名した内側のイベント（kind 13）です。"], ["使い捨ての鍵", "暗号化と署名のたびに新しく生成し、1度使った後に破棄する一時的なNostr鍵ペアです。"], ["gift wrap", "sealを使い捨ての鍵でNIP-44暗号化し、その使い捨ての鍵で署名した外側のイベント（kind 1059）です。"], ["TLS", "インターネット上でクライアントとサーバー間の通信経路を暗号化する標準プロトコル（Transport Layer Security）です。"], ["E2EE", "エンドツーエンド暗号化（End-to-End Encryption）の略で、送信者の端末で暗号化し受信者の端末だけで復号することで中継サーバーに平文を見せない仕組みです。"], ["イベントログ", "ユーザーの操作やメッセージ送受信などの発生履歴を時系列で記録したログデータです。"], ["NIP-42", "Nostrでクライアントがリレーに対し署名付きチャレンジ応答で自分の公開鍵を認証するための仕様です。"], ["pタグ", "Nostrイベントのタグ配列において、宛先や言及対象となる公開鍵（16進文字列）を指定するタグです。"], ["NIP-59", "Nostrイベントをrumor、seal、gift wrapの段階構造で包み、送信者や作成時刻などのメタデータを隠す仕様です。"], ["created_at", "Nostrイベントの作成日時を表すUNIXタイムスタンプのフィールドです。"], ["nostr-tools", "JavaScriptとTypeScript向けにNostrの鍵操作、署名、暗号化、リレー通信などを提供するオープンソースライブラリです。"], ["公開鍵", "公開鍵暗号において他者へ共有できる鍵データで、暗号化、署名検証、アカウント識別に使います。"], ["IPアドレス", "ネットワーク上で通信元の機器を識別するためのアドレスです。"], ["前方秘匿性", "長期的な秘密鍵が将来漏洩しても、過去に送受信して暗号化した通信内容までは復号できないという暗号プロトコルの性質です。"]], "ads": [["トラッカー", "Webサイトやアプリ上でユーザーの操作や閲覧行動を収集し、外部へ送信して追跡するスクリプトや仕組みです。"], ["広告SDK", "アプリ内に広告枠を表示し、広告の表示回数やクリック数を計測するために組み込まれる外部ソフトウェア開発キットです。"], ["CSP", "Content Security Policyの略で、Webページが読み込みや実行や通信を許可する送信元をHTTPヘッダなどで制限するブラウザのセキュリティ仕組みです。"], ["オリジン", "URLのスキーム（httpsなど）、ホスト名、ポート番号の組み合わせで決まるWeb上のセキュリティ境界の単位です。"], ["Cloudflare Turnstile", "ブラウザの環境検証などによって自動ボットアクセスを判別するCloudflareの人間確認ツールです。"], ["リモート設定", "アプリ本体を更新せずに、サーバーから設定値を配信して画面構成や広告枠や機能を動的に切り替える仕組みです。"], ["計測イベント", "アプリ内でユーザーがどの画面を見たかやどこをタップしたかといった操作情報を分析サーバーへ送信するテレメトリデータです。"], ["script-src 'self'", "CSPのscript-srcディレクティブで、Webアプリ自身のオリジン（'self'）から配信されたJavaScriptの実行だけを許可する指定です。"], ["connect-src", "CSPにおいて、ページ内のスクリプトがfetchやWebSocketなどで接続できる通信先URLを制限するディレクティブです。"], ["Cloudflare Web Analytics（RUM）", "ブラウザ上で計測用JavaScriptを実行してページ表示やアクセス状況を収集するCloudflareの実ユーザー計測機能です。"], ["R2", "Cloudflareが提供するS3互換のオブジェクトストレージサービスです。"], ["STUN", "NAT越え通信のために端末自身のグローバルIPアドレスとポート番号を調べる標準プロトコル（Session Traversal Utilities for NAT）です。"], ["Web Push", "Webアプリが閉じられていてもブラウザやOSの配信基盤経由で通知を受信できるWeb標準仕様です。"]], "num": [["secp256k1", "ビットコインやNostrで標準的に採用されている楕円曲線暗号のパラメータ仕様です。"], ["Nostr", "公開鍵暗号と電子署名を用い、リレーサーバー経由で中央のユーザーDBに縛られずイベントをやり取りするオープンプロトコルです。"], ["鍵ペア", "数学的に対になる公開鍵と秘密鍵の2つ1組のデータです。"], ["秘密鍵", "所有者だけが保持し、データへの署名や自分宛て暗号文の復号に使う鍵データです。"], ["WebAuthn", "生体認証やセキュリティキーを使い、パスワードなしでブラウザやOS上の認証と鍵操作を行うWeb標準APIです。"], ["PRF拡張", "WebAuthnの拡張機能（Pseudo-Random Function）の1つで、パスキー認証時にオリジンと資格情報に紐づく決定的な秘密の出力値を取り出せる仕組みです。"], ["AES-GCM", "AES暗号にGalois/Counter Modeを組み合わせた、データの機密性と改ざん検知を同時に提供する認証付き暗号方式です。"], ["npub", "Nostrの公開鍵をBech32形式（先頭がnpub1で始まる文字列）にエンコードした可読表現です。"], ["NIP-98", "Nostrの秘密鍵でHTTPリクエストのURLやメソッドなどに署名し、HTTP通信の認証を行う仕様です。"], ["Schnorr署名", "secp256k1曲線上でNostrが採用しているデジタル署名方式で、秘密鍵の所有者本人がイベントを作成したことを証明します。"], ["HKDF", "HMAC-based Key Derivation Functionの略で、秘密の入力値から暗号用途に適した安全で固定長の暗号鍵を生成する鍵導出関数です。"], ["認証器", "WebAuthnにおいて資格情報を保持し、生体認証やPINの検証後に署名やPRF値を返すハードウェアまたはOSやブラウザ上の仕組みです。"], ["エクスポートできないAES鍵", "Web Crypto APIにおいて、JavaScriptから鍵の生のバイト列を取り出せない設定（extractableがfalse）で生成したAES暗号鍵です。"], ["IndexedDB", "Webブラウザがオリジンごとに提供する、構造化データや暗号鍵オブジェクトなどを永続保存できるローカルデータベースAPIです。"]], "pw": [["nsec", "Nostrの秘密鍵をBech32形式（先頭がnsec1で始まる文字列）にエンコードした表現です。"], ["パスキー", "FIDO2とWebAuthnに基づき、生体認証や端末のロック解除を用いて認証を行うオリジン紐付きの資格情報です。"], ["ワンタイムコード", "1回のログインや認証にだけ有効な使い捨ての確認コードで、SMSなどで送られる方式が一般的です。"], ["中継型フィッシング", "攻撃者が本物のログインサイトと利用者の間に偽サイトを挟み、入力されたパスワードやワンタイムコードをリアルタイムで中継して認証後のセッションを奪う攻撃です。"], ["セッション奪取", "ログインした後に発行されるセッションのトークンやクッキーを攻撃者が横取りし、本人になりすまして操作することです。"], ["XSS", "Cross-Site Scriptingの略で、Webサイトの脆弱性を突いて悪意のあるJavaScriptをブラウザ上で実行させる攻撃です。"], ["復旧コード", "端末をすべてなくした時にアカウントを戻すための28文字のコード（140ビット）です。"]], "leak": [["ダンプ", "データベースに保存されているデータをファイルなどに丸ごと書き出すこと、またその書き出されたデータです。"], ["暗号文", "暗号化アルゴリズムで変換され、正しい復号鍵がなければ元のデータを読めない状態のデータです。"], ["平文", "暗号化されていない、そのまま内容を読み取れる状態の生データです。"], ["エンドポイント", "Web Push通知の配信先を特定するためにブラウザのプッシュサービスから発行される専用URLです。"], ["SHA-256", "任意の入力データから256ビットの固定長ハッシュ値を算出する暗号学的ハッシュ関数です。"]], "trk": [["解析SDK", "アプリに組み込んで画面表示やタップや滞在時間などの操作ログを自動収集し分析サーバーへ送る外部開発キットです。"], ["イベント", "アプリ解析の文脈で、ユーザーのタップや画面表示など1回ごとの操作を記録し送信するデータ単位です（Nostrプロトコル上のイベントとは別概念）。"], ["セグメント", "収集した行動イベントや属性をもとに、興味や行動傾向が似ているユーザー群を分類したグループです。"], ["クライアント", "サーバーやリレーに接続して動作するユーザー側のアプリやWebブラウザ上のソフトウェアです。"], ["日替わりの秘密の値", "1日ごとに新しく生成して使い、その日が終わると破棄される一時的な秘密の値です。"], ["HyperLogLog", "データ要素そのものを記憶せずにハッシュ値のビットパターンから重複を除いた要素数だけを極めて少ないメモリで概算する確率的アルゴリズムです。"], ["Workers", "Cloudflareのエッジネットワーク上でJavaScriptなどを実行するサーバーレス実行基盤（Cloudflare Workers）です。"], ["invocation logs", "Cloudflare WorkersにおいてHTTPリクエストや関数呼び出しごとの実行履歴とメタデータを自動記録するログ機能です。"], ["console.log", "JavaScriptで実行中のログメッセージやエラー情報を出力する標準関数です。"], ["Workers Logs", "Cloudflare Workersの実行中に出力されたログを一時的に保持し閲覧できるログ収集基盤です。"], ["UTC", "協定世界時（Coordinated Universal Time）の略で、タイムゾーンに依存しない世界標準の基準時刻です。"]], "ai": [["tegami-agent", "利用者のPC上で動作するTegamiのAI連携用エージェントプログラムで、独自のNostr鍵を持ち人間と同じNIP-17のgift wrapでやり取りします。"], ["APIキー", "外部のAPIサービスを利用する際の契約者認証や課金紐づけに使う秘密のトークン文字列です。"], ["claude -p", "Anthropic社のコマンドラインAIツールであるClaude Codeを、非対話モード（プロンプトを直接渡して結果を標準出力に返すオプション-p）で実行するコマンドです。"], ["MCPサーバー", "Model Context Protocol（MCP）に準拠し、AIクライアントから外部データや機能を共通の形式で呼び出せるようにするサーバープログラムです。"], ["Claude Code", "Anthropic社が提供している、ローカル端末上で動作するAI開発や作業を支援するCLIツールです。"], ["API", "Application Programming Interfaceの略で、ソフトウェア同士がネットワーク越しなどに機能やデータをやり取りするための接続窓口と規約です。"]]}, "en": {"seal": [["API server", "A central server that handles application requests, stores user data, and relays messages."], ["relay", "A Nostr server that accepts events from clients, stores them, and delivers them to matching clients."], ["NIP-17", "A Nostr specification for private direct messages."], ["rumor", "An unsigned Nostr event containing the raw message payload (kind 14 for chat or kind 15 for files)."], ["kind", "An integer field in a Nostr event that identifies the event type."], ["NIP-44", "Nostr's versioned authenticated encryption specification that derives a shared secret from sender and recipient keys."], ["seal", "An inner Nostr event (kind 13) holding a NIP-44-encrypted rumor signed by the sender's secret key."], ["one-time key", "An ephemeral Nostr key pair generated for a single encryption and signing operation and then discarded."], ["gift wrap", "An outer Nostr event (kind 1059) that NIP-44-encrypts and signs a seal with a one-time key."], ["TLS", "Transport Layer Security, the standard protocol that encrypts network traffic between client and server."], ["E2EE", "End-to-End Encryption, where data is encrypted on the sender's device and decrypted only on the recipient's device so servers cannot read it."], ["event logs", "Time-stamped records of user actions or messaging activity stored by a server."], ["NIP-42", "A Nostr specification for authenticating a client's public key to a relay using a signed challenge."], ["p tag", "A Nostr event tag referencing a target public key in hexadecimal form."], ["NIP-59", "A Nostr specification defining the rumor, seal, and gift wrap layering to hide sender and timestamp metadata."], ["created_at", "The UNIX timestamp field on a Nostr event indicating when it was created."], ["nostr-tools", "A widely used open-source JavaScript/TypeScript library for Nostr keys, signing, encryption, and relay interaction."], ["public key", "The shareable half of an asymmetric key pair used for encryption, signature verification, and identity."], ["IP", "An Internet Protocol address that identifies a client's network endpoint."], ["forward secrecy", "A property ensuring that past encrypted messages cannot be decrypted even if long-term secret keys are later compromised."]], "ads": [["tracker", "Scripts or code that monitor user actions and views across a site or app and report them externally."], ["ad SDK", "A third-party software development kit embedded in apps to render ads and measure impressions or clicks."], ["CSP", "Content Security Policy, a browser security mechanism that restricts allowed origins for scripts and network requests."], ["origin", "A web security boundary defined by scheme, host, and port."], ["Cloudflare Turnstile", "Cloudflare's human-verification widget that blocks automated bot sign-ups without conventional puzzles."], ["remote config", "A mechanism that fetches server-side flags to modify app UI, features, or ad placements without releasing an update."], ["telemetry", "Automated interaction data such as taps and screen views sent from a client to an analytics server."], ["script-src 'self'", "A CSP directive restricting executable JavaScript to resources served from the app's own origin ('self')."], ["connect-src", "A CSP directive that restricts which URLs scripts can connect to via fetch or WebSocket."], ["Cloudflare Web Analytics (RUM)", "Cloudflare's Real User Monitoring analytics service that runs browser beacons to track page views and performance."], ["R2", "Cloudflare's S3-compatible object storage service."], ["STUN", "Session Traversal Utilities for NAT, a protocol used to discover a device's public IP address and port across NATs."], ["Web Push", "A web standard allowing push notifications to reach browsers even when the web app is closed."]], "num": [["secp256k1", "The elliptic curve parameter specification used by Bitcoin and Nostr."], ["Nostr", "An open messaging protocol built on public-key signatures and independent relays rather than central user databases."], ["key pair", "A mathematically linked pair of a public key and a secret key."], ["secret key", "The private half of an asymmetric key pair used for signing events and decrypting incoming messages."], ["WebAuthn", "A web standard (Web Authentication API) for passwordless authentication via platform biometrics or hardware keys."], ["PRF extension", "The Pseudo-Random Function extension to WebAuthn, which returns a deterministic, origin-bound secret output during passkey authentication."], ["AES-GCM", "Advanced Encryption Standard in Galois/Counter Mode, an authenticated encryption algorithm ensuring both confidentiality and integrity."], ["npub", "The Bech32-encoded string representation of a Nostr public key (starting with npub1)."], ["NIP-98", "A Nostr specification for HTTP authentication that attaches a signed Nostr event to an HTTP request."], ["Schnorr", "The Schnorr digital signature algorithm over secp256k1 used in Nostr to prove event authenticity."], ["HKDF", "HMAC-based Key Derivation Function, a standard method for deriving cryptographically strong keys from a secret input."], ["authenticator", "The hardware security key or platform/browser component in WebAuthn that stores credentials and responds to biometric or PIN checks."], ["non-extractable AES key", "A Web Crypto AES key created with extractable set to false so scripts can perform encryption and decryption without reading its raw bytes."], ["IndexedDB", "A persistent, origin-scoped database API built into web browsers capable of storing Web Crypto key objects."]], "pw": [["nsec", "The Bech32-encoded string representation of a Nostr secret key (starting with nsec1)."], ["passkey", "An origin-bound FIDO2/WebAuthn credential unlocked by biometrics or a device PIN instead of a password."], ["one-time code", "A temporary single-use verification code often sent via SMS. Typical apps pair it with a password, which remains vulnerable to adversary-in-the-middle phishing, whereas Tegami does not use login codes or passwords."], ["adversary-in-the-middle phishing", "A phishing attack where a proxy site relays credentials and one-time codes to the real service in real time to hijack the session."], ["session hijacking", "Stealing the session token or cookie issued after login and acting as the user."], ["XSS", "Cross-Site Scripting, an attack that injects malicious JavaScript into a web page's context."], ["recovery code", "A 28-character code (140 bits) for getting an account back after losing every device."]], "leak": [["dump", "Exporting the entire contents of a database into a file, often occurring during a breach."], ["ciphertext", "Data transformed by an encryption algorithm so it cannot be read without the matching decryption key."], ["plaintext", "Unencrypted data in readable form."], ["endpoint", "A unique delivery URL assigned by a browser's push service to receive Web Push notifications."], ["SHA-256", "A cryptographic hash function that computes a fixed 256-bit digest from data."]], "trk": [["analytics SDK", "A third-party software development kit embedded in apps to log screen views, taps, and dwell time for analytics backends."], ["event", "In app analytics, a telemetry record capturing an individual user interaction such as a tap or view (distinct from Nostr events)."], ["segments", "Groups of users categorized by shared interests or behaviors derived from tracking logs."], ["client", "The user-facing application or browser code that communicates with relays or servers."], ["per-day secret", "A temporary secret generated for a single day and discarded when the day ends."], ["HyperLogLog", "A probabilistic cardinality-estimation algorithm that approximates distinct counts with minimal memory without storing individual items."], ["Workers", "Cloudflare Workers, a serverless runtime executing server-side code across Cloudflare's edge network."], ["invocation logs", "Automatic per-request execution logs recorded by Cloudflare Workers."], ["console.log", "The standard JavaScript logging function for emitting runtime output or errors."], ["Workers Logs", "Cloudflare's log storage and inspection service for output emitted by Workers."], ["UTC", "Coordinated Universal Time, the timezone-independent global time standard."]], "ai": [["tegami-agent", "Tegami's local agent program running on the user's PC with its own Nostr key, exchanging NIP-17 gift wraps like any human peer."], ["API key", "A secret token used to authenticate requests and bill usage to an external API provider."], ["claude -p", "Running the Claude Code CLI in non-interactive print mode (-p) to pass a prompt and read the response from stdout."], ["MCP server", "A server implementing the Model Context Protocol so AI clients can access external tools and context through a standard interface."], ["Claude Code", "Anthropic's command-line AI tool that runs locally in a user's terminal."], ["API", "Application Programming Interface, the defined protocol through which software exchanges data and requests."]]}};
const terms = (id) => TERMS[lang === 'ja' ? 'ja' : 'en'][id] || [];

// ─── 絵の部品 ───────────────────────────────────────
const PHONE = 'fill-white stroke-neutral-300 dark:fill-night-card dark:stroke-neutral-600';
const SRV = { ty: 'fill-neutral-100 stroke-neutral-300 dark:fill-white/5 dark:stroke-night-line', tg: 'fill-forest-50 stroke-forest-600/40 dark:fill-forest-950 dark:stroke-forest-300/30' };
const HEAD = { ty: 'fill-neutral-500 dark:fill-neutral-400', tg: 'fill-forest-600 dark:fill-forest-300' };
const MUTED = 'fill-neutral-500 dark:fill-neutral-400';
const GRAY = 'fill-neutral-200 dark:fill-neutral-700';
const MID = 'fill-neutral-400 dark:fill-neutral-500';
const RED = { bg: 'fill-red-50 dark:fill-red-950/60', tx: 'fill-red-700 dark:fill-red-300' };
const GRN = { bg: 'fill-white dark:fill-white/10', tx: 'fill-forest-700 dark:fill-forest-300' };

const a = (name, keep) => `data-a="${name}"${keep ? ' data-keep' : ''}`;
const txt = (x, y, s, cls, size = 16, w = 400, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${w}" class="${cls}">${s}</text>`;
const phone = (cx, label, y = 70, w = 70, h = 160) => `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" rx="14" class="${PHONE}" stroke-width="2"/>` + (label ? txt(cx, y + h + 26, label, MUTED, 15) : '');
const server = (cx, w, label, tone) => txt(cx, 40, label, HEAD[tone], 17, 600) + `<rect x="${cx - w / 2}" y="56" width="${w}" height="184" rx="14" class="${SRV[tone]}" stroke-width="1.5"/>`;
const tag = (cx, y, w, s, c) => `<rect x="${cx - w / 2}" y="${y - 14}" width="${w}" height="28" rx="7" class="${c.bg}"/>` + txt(cx, y + 5, s, c.tx, 15);
const bubble = (fill, lines = true) => `<rect x="-20" y="-12" width="40" height="24" rx="9" ${fill}/>` + (lines ? '<path d="M-12 -3 H12 M-12 4 H4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>' : '');
const at = (x, y) => `transform="translate(${x} ${y})"`;
const ripple = (name, color = '#7c2eda') => `<circle ${a(name)} r="14" fill="none" stroke="${color}" stroke-width="3"/>`;

// ─── 動き ───────────────────────────────────────────
const EASE = 'cubic-bezier(.65,0,.35,1)';
const K = (list) => list.map(([offset, p]) => ({ offset, easing: EASE, ...p }));
const vis = (s, e = .94) => K([[0, { opacity: 0 }], [s, { opacity: 0 }], [s + .03, { opacity: 1 }], [e, { opacity: 1 }], [Math.min(e + .05, 1), { opacity: 0 }], [1, { opacity: 0 }]]);
const pop = (s, e = .94) => K([[0, { opacity: 0, transform: 'scale(.5)' }], [s, { opacity: 0, transform: 'scale(.5)', easing: 'cubic-bezier(.2,.8,.3,1)' }], [s + .025, { opacity: 1, transform: 'scale(1.12)' }], [s + .045, { opacity: 1, transform: 'scale(1)' }], [e, { opacity: 1, transform: 'scale(1)' }], [Math.min(e + .05, 1), { opacity: 0, transform: 'scale(1)' }], [1, { opacity: 0, transform: 'scale(1)' }]]);
const grow = (s) => K([[0, { opacity: 0, transform: 'scaleY(0)' }], [s, { opacity: 1, transform: 'scaleY(0)' }], [s + .08, { opacity: 1, transform: 'scaleY(1)' }], [.94, { opacity: 1, transform: 'scaleY(1)' }], [.99, { opacity: 0, transform: 'scaleY(1)' }], [1, { opacity: 0, transform: 'scaleY(0)' }]]);
// 点の列 [時刻, x, y, 不透明度, 大きさ]
const mv = (pts) => {
  const f = pts.map(([o, x, y, op = 1, s = 1, e]) => [o, { opacity: op, transform: `translate(${x}px,${y}px) scale(${s})`, ...(e ? { easing: e } : {}) }]);
  if (f[0][0] > 0) f.unshift([0, { ...f[0][1], opacity: 0 }]);
  if (f[f.length - 1][0] < 1) f.push([1, { ...f[f.length - 1][1], opacity: 0 }]);
  return K(f);
};
// 出発して、着いたら消える
const IN = 'cubic-bezier(.45,0,.85,.55)', OUT = 'cubic-bezier(.15,.45,.55,1)';
const fly = (s, e, x1, y1, x2, y2, arc = -30) => mv([[s, x1, y1, 0, .6], [s + .02, x1, y1, 1, 1, IN], [(s + e) / 2, (x1 + x2) / 2, (y1 + y2) / 2 + arc, 1, 1, OUT], [e, x2, y2, 1, 1], [e + .02, x2, y2, 0, .9]]);
const flyStay = (s, e, x1, y1, x2, y2, arc = -30) => mv([[s, x1, y1, 0, .6], [s + .02, x1, y1, 1, 1, IN], [(s + e) / 2, (x1 + x2) / 2, (y1 + y2) / 2 + arc, 1, 1, OUT], [e, x2, y2, 1, 1], [.94, x2, y2, 1, 1], [.99, x2, y2, 0, 1]]);
const tap = (s, x, y) => mv([[s, x, y, 0, .3], [s + .005, x, y, .9, .4], [s + .05, x, y, .5, 1.3], [s + .09, x, y, 0, 1.7]]);
const flash = (s) => K([[0, { opacity: 0 }], [s, { opacity: 0 }], [s + .02, { opacity: 1 }], [s + .05, { opacity: .2 }], [s + .07, { opacity: 1 }], [s + .12, { opacity: .6 }], [.94, { opacity: .6 }], [.99, { opacity: 0 }], [1, { opacity: 0 }]]);

// ─── 7つの場面 ──────────────────────────────────────
const S = [];

// 1. メッセージの中身
S.push({ id: 'seal',
  ty: server(260, 170, t('srv.ty'), 'ty')
    + `<g class="fx" ${a('s-r1', 1)}>${tag(260, 131, 154, t('seal.r1'), RED)}</g>`
    + `<g class="fx" ${a('s-r2', 1)}>${tag(260, 163, 154, t('seal.r2'), RED)}</g>`
    + `<g class="fx" ${a('s-r3', 1)}>${tag(260, 195, 154, t('seal.r3'), RED)}</g>`
    + phone(55, t('you')) + phone(465, t('friend'))
    + `<g ${a('s-sent', 1)} ${at(55, 175)}>${bubble(`class="${MID}"`, false)}</g>`
    + `<g ${a('s-tyrecv', 1)} ${at(465, 140)}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g ${a('s-tymsg')}>${bubble(`class="${MID}"`)}</g>`
    + `<g ${a('s-ad', 1)} ${at(55, 104)}><rect x="-27" y="-13" width="54" height="26" rx="6" class="fill-amber-300 dark:fill-amber-400"/>${txt(0, 5, t('ad'), '', 15, 700).replace('class=""', 'fill="#5a3b00"')}</g>`,
  tg: server(260, 170, t('srv.tg'), 'tg')
    + `<g ${a('s-lock')}>${txt(260, 152, t('seal.lock'), GRN.tx, 16, 600)}</g>`
    + `<g ${a('s-del', 1)}>${txt(260, 208, t('seal.del'), MUTED, 15)}</g>`
    + phone(55, t('you')) + phone(465, t('friend'))
    + `<g ${a('s-sent', 1)} ${at(55, 175)}>${bubble('fill="#106c4a"', false)}</g>`
    + `<g ${a('s-tgrecv', 1)} ${at(465, 140)}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g ${a('s-env', 1)} ${at(260, 100)}><use href="#env"/></g>`
    + `<g ${a('s-env2')}><use href="#env"/></g>`,
  anim: {
    's-sent': vis(.0),
    's-tymsg': mv([[.02, 55, 175, 0, .6], [.05, 55, 175, 1, 1], [.15, 260, 94], [.18, 260, 94], [.27, 465, 140], [.29, 465, 140, 0, .9]]),
    's-tyrecv': vis(.27),
    's-r1': pop(.32), 's-r2': pop(.38), 's-r3': pop(.44),
    's-ad': mv([[.63, 260, 222, 0, .5], [.66, 260, 222, 1, 1.1], [.68, 260, 222, 1, 1], [.78, 55, 104, 1, 1], [.80, 55, 104, 1, 1.12], [.82, 55, 104, 1, 1], [.94, 55, 104, 1, 1], [.99, 55, 104, 0, 1]]),
    's-env': mv([[.05, 55, 175, 0, .3], [.09, 55, 175, 1, 1.12], [.11, 55, 175, 1, 1], [.24, 260, 100], [.70, 260, 100], [.76, 260, 100, 0, .6]]),
    's-lock': vis(.30),
    's-env2': fly(.38, .52, 260, 100, 465, 140, -24),
    's-tgrecv': vis(.53),
    's-del': vis(.64),
  } });

// 2. 広告とニュース
const bigPhone = `<rect x="180" y="12" width="160" height="246" rx="22" class="${PHONE}" stroke-width="2"/>`;
const rows = [70, 110, 150].map((y) => `<circle cx="206" cy="${y}" r="12" class="${GRAY}"/><rect x="226" y="${y - 9}" width="86" height="8" rx="4" class="${GRAY}"/><rect x="226" y="${y + 3}" width="56" height="7" rx="3.5" class="${GRAY}"/>`).join('');
const tabBar = (n) => `<path d="M180 220 H340" class="stroke-neutral-200 dark:stroke-night-line" stroke-width="1.5"/>` + Array.from({ length: n }, (_, i) => `<circle cx="${180 + 160 / (n + 1) * (i + 1)}" cy="239" r="8" class="${GRAY}"/>`).join('');
const head = (s) => txt(196, 44, s, 'fill-neutral-800 dark:fill-neutral-100', 16, 700, 'start');
const screen = (inner) => `<rect x="187" y="22" width="146" height="194" rx="14" class="fill-white dark:fill-night-card"/>${inner}`;
S.push({ id: 'ads',
  ty: bigPhone + head(t('ads.talk'))
    + `<g ${a('a-rows', 1)} transform="translate(0 40)">${rows}</g>`
    + `<g class="fx" ${a('a-ad', 1)}><rect x="192" y="58" width="136" height="34" rx="8" class="fill-amber-300 dark:fill-amber-400"/>${txt(260, 80, t('ad'), '', 15, 700).replace('class=""', 'fill="#5a3b00"')}</g>`
    + tabBar(5)
    + [1, 2, 3, 4].map((i) => `<circle class="fx" ${a('a-tab' + i, 1)} cx="${180 + 160 / 6 * (i + 1)}" cy="239" r="8" fill="#f59e0b"/>`).join('')
    + ripple('a-tap', '#737373')
    + `<g ${a('a-news', 1)}>${screen(txt(196, 50, t('ads.news'), 'fill-neutral-800 dark:fill-neutral-100', 16, 700, 'start') + [66, 116, 166].map((y) => `<rect x="196" y="${y}" width="40" height="38" rx="6" fill="#f59e0b"/><rect x="242" y="${y + 4}" width="80" height="8" rx="4" class="${GRAY}"/><rect x="242" y="${y + 18}" width="60" height="7" rx="3.5" class="${GRAY}"/>`).join(''))}</g>`,
  tg: bigPhone + head(t('ads.talk'))
    + `<g>${rows}</g>`
    + `<g class="fx" ${a('a-badge', 1)}><circle cx="318" cy="70" r="9" fill="#106c4a"/>${txt(318, 75, '1', '', 12, 700).replace('class=""', 'fill="#fff"')}</g>`
    + `<rect class="fx" ${a('a-t1', 1)} x="262" y="31" width="34" height="17" rx="8.5" fill="#106c4a"/><rect class="fx ${GRAY}" ${a('a-t2', 1)} x="299" y="31" width="34" height="17" rx="8.5"/>`
    + ripple('a-tap2')
    + `<g ${a('a-chat', 1)}>${screen(head(t('friend')) + `<g ${at(222, 82)}>${bubble(`class="${GRAY}"`, false)}</g><g ${at(298, 118)}>${bubble('fill="#106c4a"', false)}</g><g ${at(222, 154)}>${bubble(`class="${GRAY}"`, false)}</g>`)}</g>`,
  anim: {
    'a-rows': mv([[0, 0, 0, 1], [.06, 0, 0, 1], [.12, 0, 40, 1], [.94, 0, 40, 1], [.99, 0, 40, 0]]),
    'a-ad': pop(.10),
    'a-tab1': pop(.33), 'a-tab2': pop(.37), 'a-tab3': pop(.41), 'a-tab4': pop(.45),
    'a-tap': tap(.66, 233, 239),
    'a-news': vis(.73),
    'a-badge': pop(.08),
    'a-t1': pop(.33), 'a-t2': pop(.37),
    'a-tap2': tap(.66, 260, 70),
    'a-chat': vis(.73),
  } });

// 3. 電話番号
const tallPhone = (cx) => `<rect x="${cx - 60}" y="20" width="120" height="236" rx="20" class="${PHONE}" stroke-width="2"/>`;
S.push({ id: 'num',
  ty: tallPhone(90) + server(345, 170, t('srv.ty'), 'ty')
    + txt(90, 92, t('num.label'), MUTED, 15)
    + `<rect x="45" y="104" width="90" height="32" rx="7" fill="none" class="stroke-neutral-300 dark:stroke-neutral-600" stroke-width="2"/>`
    + `<g ${a('n-type', 1)}>${txt(90, 126, '090-', 'fill-neutral-800 dark:fill-neutral-100', 16, 600)}</g>`
    + `<rect x="45" y="150" width="90" height="30" rx="15" class="${MID}"/>` + txt(90, 170, t('num.next'), '', 14, 600).replace('class=""', 'fill="#fff"')
    + ripple('n-tap', '#737373')
    + `<g ${a('n-pill')}><rect x="-36" y="-14" width="72" height="28" rx="14" class="${RED.bg}"/>${txt(0, 5, '090-', RED.tx, 15, 600)}</g>`
    + `<g class="fx" ${a('n-r1', 1)}>${tag(345, 112, 150, t('num.label'), RED)}</g>`
    + `<g class="fx" ${a('n-r2', 1)}>${tag(345, 184, 150, t('num.acc'), RED)}</g>`
    + `<path ${a('n-link', 1)} d="M345 128 V168" stroke="#dc2626" stroke-width="3" stroke-dasharray="5 4"/>`,
  tg: tallPhone(90) + server(345, 170, t('srv.tg'), 'tg')
    + `<rect x="40" y="150" width="100" height="32" rx="16" fill="#106c4a"/>` + txt(90, 171, t('num.start'), '', 15, 600).replace('class=""', 'fill="#fff"')
    + ripple('n-tap2')
    + `<g ${at(90, 90)}><g class="fx" ${a('n-key', 1)}><use href="#key"/></g></g>`
    + `<g class="fx" ${a('n-pk', 1)}><circle cx="118" cy="74" r="13" fill="#106c4a"/><path d="M112 74 L116.5 78.5 L124 70" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`
    + `<g ${a('n-id')}><rect x="-40" y="-14" width="80" height="28" rx="14" class="fill-forest-50 stroke-forest-600/40 dark:fill-forest-950" stroke-width="1"/>${txt(0, 5, t('num.pill'), GRN.tx, 15, 600)}</g>`
    + `<g class="fx" ${a('n-row', 1)}>${tag(345, 148, 150, t('num.id'), GRN)}</g>`,
  anim: {
    'n-type': vis(.05), 'n-tap': tap(.18, 90, 165),
    'n-pill': fly(.32, .44, 90, 120, 345, 112, -40), 'n-r1': pop(.44),
    'n-r2': pop(.66), 'n-link': vis(.72),
    'n-tap2': tap(.08, 90, 166),
    'n-key': pop(.32), 'n-pk': pop(.44),
    'n-id': fly(.64, .74, 90, 120, 345, 148, -40), 'n-row': pop(.74),
  } });

// 4. 乗っ取り
S.push({ id: 'pw',
  ty: tallPhone(90) + tallPhone(430)
    + txt(90, 282, t('you'), MUTED, 15) + `<g class="fill-red-700 dark:fill-red-300">${txt(430, 282, t('pw.thief'), '', 15)}</g>`
    + txt(90, 92, t('pw.label'), MUTED, 15)
    + `<rect x="45" y="104" width="90" height="32" rx="7" fill="none" class="stroke-neutral-300 dark:stroke-neutral-600" stroke-width="2"/>`
    + `<g ${a('p-dots', 1)}>${txt(90, 127, '●●●●●', 'fill-neutral-800 dark:fill-neutral-100', 13)}</g>`
    + `<rect x="45" y="150" width="90" height="30" rx="15" class="${MID}"/>` + txt(90, 170, t('pw.login'), '', 14, 600).replace('class=""', 'fill="#fff"')
    + `<g class="fx" ${a('p-fake', 1)}><rect x="205" y="128" width="110" height="44" rx="8" fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/>${txt(260, 156, t('pw.fake'), RED.tx, 15, 600)}</g>`
    + `<g ${a('p-steal')}><rect x="-40" y="-14" width="80" height="28" rx="14" class="${RED.bg}"/>${txt(0, 5, '●●●●●', RED.tx, 12)}</g>`
    + `<g class="fx text-red-600 dark:text-red-400" ${a('p-in', 1)}><g ${at(430, 110)}><use href="#person"/></g>${txt(430, 160, t('pw.in'), RED.tx, 14, 600)}</g>`,
  tg: tallPhone(90) + tallPhone(430)
    + txt(90, 282, t('you'), MUTED, 15) + `<g>${txt(430, 282, t('pw.thief'), MUTED, 15)}</g>`
    + `<g ${at(90, 110)}><use href="#face"/></g>`
    + `<g class="fx" ${a('p-ok', 1)}><circle cx="90" cy="170" r="16" fill="#106c4a"/><path d="M82 170 L88 176 L98 165" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`
    + `<g class="fx" ${a('p-q', 1)}>${txt(430, 130, '?', MUTED, 44, 700)}</g>`
    + `<g ${at(90, 225)}><g class="fx" ${a('p-key', 1)}><use href="#key"/></g></g>`
    + `<g ${at(430, 190)}><g class="fx text-neutral-400 dark:text-neutral-500" ${a('p-locked', 1)}><use href="#lock"/></g></g>`,
  anim: {
    'p-dots': vis(.04),
    'p-fake': pop(.30), 'p-steal': mv([[.34, 90, 120, 0, .6], [.36, 90, 120, 1, 1], [.44, 260, 196, 1, 1], [.47, 260, 196, 1, 1], [.55, 430, 120, 1, 1], [.57, 430, 120, 0, .9]]),
    'p-in': pop(.66),
    'p-ok': pop(.10),
    'p-q': pop(.36),
    'p-key': pop(.66), 'p-locked': pop(.72),
  } });

// 5. 情報の流出
const breach = (name) => `<rect ${a(name)} x="90" y="56" width="200" height="184" rx="14" fill="none" stroke="#dc2626" stroke-width="4"/>`;
S.push({ id: 'leak',
  ty: server(190, 200, t('srv.ty'), 'ty') + breach('l-br')
    + `<g class="fx" ${a('l-r1', 1)}>${tag(190, 110, 160, t('leak.r1'), RED)}</g>`
    + `<g class="fx" ${a('l-r2', 1)}>${tag(190, 148, 160, t('leak.r2'), RED)}</g>`
    + `<g class="fx" ${a('l-r3', 1)}>${tag(190, 186, 160, t('leak.r3'), RED)}</g>`
    + `<g class="text-neutral-400 dark:text-neutral-500" ${at(440, 120)}><use href="#person"/></g>` + txt(440, 160, t('leak.out'), MUTED, 15)
    + [1, 2, 3].map((i) => `<g ${a('l-o' + i, 1)} ${at(440, 170 + i * 28)}><rect x="-50" y="-12" width="100" height="24" rx="6" class="${RED.bg}"/>${txt(0, 5, t('leak.r' + i), RED.tx, 15)}</g>`).join(''),
  tg: server(190, 200, t('srv.tg'), 'tg') + breach('l-br2')
    + [0, 1, 2].map((i) => `<g ${at(130 + i * 60, 140)}><g class="fx" ${a('l-e' + i, 1)}><use href="#env"/></g></g>`).join('')
    + `<g class="text-neutral-400 dark:text-neutral-500" ${at(440, 120)}><use href="#person"/></g>` + txt(440, 160, t('leak.out'), MUTED, 15)
    + [0, 1, 2].map((i) => `<g ${a('l-x' + i, 1)} ${at(400 + i * 40, 200)}><use href="#env"/></g>`).join('')
    + `<g ${a('l-no', 1)}>${txt(442, 252, t('leak.no'), GRN.tx, 15, 600)}</g>`,
  anim: {
    'l-r1': pop(.04), 'l-r2': pop(.10), 'l-r3': pop(.16),
    'l-br': flash(.34), 'l-br2': flash(.34),
    'l-o1': flyStay(.62, .72, 190, 110, 440, 198, -30),
    'l-o2': flyStay(.65, .75, 190, 148, 440, 226, -30),
    'l-o3': flyStay(.68, .78, 190, 186, 440, 254, -30),
    'l-e0': pop(.04), 'l-e1': pop(.10), 'l-e2': pop(.16),
    'l-x0': flyStay(.62, .72, 130, 140, 392, 205, -30),
    'l-x1': flyStay(.65, .75, 190, 140, 442, 205, -30),
    'l-x2': flyStay(.68, .78, 250, 140, 492, 205, -30),
    'l-no': vis(.80),
  } });

// 6. 行動の記録
const tiles = [[62, 60], [118, 60], [62, 120], [118, 120], [62, 180], [118, 180]].map(([x, y]) => `<rect x="${x - 24}" y="${y - 22}" width="48" height="44" rx="8" class="${GRAY}"/>`).join('');
S.push({ id: 'trk',
  ty: tallPhone(90) + tiles + server(345, 170, t('srv.ty'), 'ty')
    + ripple('t-p1', '#737373') + ripple('t-p2', '#737373') + ripple('t-p3', '#737373')
    + [1, 2, 3].map((i) => `<circle ${a('t-d' + i)} r="6" fill="#dc2626"/>`).join('')
    + `<g class="fx" ${a('t-r1', 1)}>${tag(345, 90, 150, t('trk.r1'), RED)}</g>`
    + `<g class="fx" ${a('t-r2', 1)}>${tag(345, 122, 150, t('trk.r2'), RED)}</g>`
    + `<g class="fx" ${a('t-r3', 1)}>${tag(345, 154, 150, t('trk.r3'), RED)}</g>`
    + [0, 1, 2].map((i) => `<rect class="fxb" ${a('t-b' + i, 1)} x="${300 + i * 34}" y="${222 - [26, 42, 18][i]}" width="22" height="${[26, 42, 18][i]}" rx="3" fill="#dc2626"/>`).join('')
    + `<g ${a('t-int', 1)}>${txt(345, 270, t('trk.int'), RED.tx, 14, 600)}</g>`,
  tg: tallPhone(90) + tiles + server(345, 170, t('srv.tg'), 'tg')
    + ripple('t-q1') + ripple('t-q2') + ripple('t-q3')
    + `<g class="fx" ${a('t-cnt', 1)}>${txt(345, 120, t('trk.count'), MUTED, 14)}${txt(345, 152, '12,480', 'fill-neutral-800 dark:fill-neutral-100', 26, 700)}</g>`
    + `<g class="fx" ${a('t-pub', 1)}><rect x="280" y="180" width="130" height="28" rx="14" fill="#106c4a"/>${txt(345, 199, t('trk.pub'), '', 14, 600).replace('class=""', 'fill="#fff"')}</g>`,
  anim: {
    't-p1': tap(.04, 62, 60), 't-p2': tap(.12, 118, 120), 't-p3': tap(.20, 62, 180),
    't-d1': fly(.05, .14, 62, 60, 300, 90, -20), 't-d2': fly(.13, .22, 118, 120, 300, 122, -20), 't-d3': fly(.21, .29, 62, 180, 300, 154, -20),
    't-r1': pop(.32), 't-r2': pop(.38), 't-r3': pop(.44),
    't-b0': grow(.64), 't-b1': grow(.67), 't-b2': grow(.70), 't-int': vis(.74),
    't-q1': tap(.04, 62, 60), 't-q2': tap(.12, 118, 120), 't-q3': tap(.20, 62, 180),
    't-cnt': pop(.33), 't-pub': pop(.66),
  } });

// 7. AI
S.push({ id: 'ai',
  ty: server(260, 170, t('ai.co'), 'ty')
    + `<g class="fx text-neutral-400 dark:text-neutral-500" ${at(260, 92)}><use href="#spark"/></g>`
    + `<g class="fx" ${a('i-r1', 1)}>${tag(260, 150, 150, t('ai.r1'), RED)}</g>`
    + `<g class="fx" ${a('i-r2', 1)}>${tag(260, 186, 150, t('ai.r2'), RED)}</g>`
    + phone(55, t('you')) + phone(465, t('friend'))
    + `<g ${a('i-fmsg')}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g ${a('i-got', 1)} ${at(55, 120)}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g ${a('i-mine', 1)} ${at(55, 160)}>${bubble(`class="${MID}"`, false)}</g>`
    + `<g ${at(55, 200)}><g class="fx text-neutral-500" ${a('i-on', 1)}><use href="#spark"/></g></g>`
    + `<g ${a('i-up1')}>${bubble(`class="${MID}"`, false)}</g><g ${a('i-up2')}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g class="fx" ${a('i-q', 1)}>${txt(465, 165, '?', RED.tx, 40, 700)}</g>`,
  tg: txt(260, 40, t('ai.pc'), HEAD.tg, 17, 600)
    + `<rect x="185" y="70" width="150" height="104" rx="10" class="${SRV.tg}" stroke-width="2"/><path d="M240 174 L232 204 H288 L280 174" class="fill-forest-50 stroke-forest-600/40 dark:fill-forest-950" stroke-width="2"/>`
    + `<g class="fx text-nostr-600 dark:text-nostr-300" ${at(260, 122)}><use href="#spark"/></g>`
    + phone(55, t('you')) + phone(465, t('friend'))
    + `<g ${a('i-fmsg2')}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g ${a('i-got2', 1)} ${at(55, 120)}>${bubble(`class="${GRAY}"`, false)}</g>`
    + `<g class="fx" ${a('i-ask', 1)}><rect x="402" y="128" width="112" height="72" rx="10" class="fill-white stroke-neutral-300 dark:fill-night-card dark:stroke-neutral-600" stroke-width="1.5"/>${txt(458, 152, t('ai.ask'), 'fill-neutral-800 dark:fill-neutral-100', 14, 600)}<rect x="426" y="164" width="64" height="26" rx="13" fill="#106c4a"/>${txt(458, 182, t('ai.yes'), '', 14, 600).replace('class=""', 'fill="#fff"')}</g>`
    + ripple('i-tap')
    + `<g ${at(55, 200)}><g class="fx text-nostr-600 dark:text-nostr-300" ${a('i-join', 1)}><use href="#spark"/></g></g>`
    + `<g ${at(465, 92)}><g class="fx text-nostr-600 dark:text-nostr-300" ${a('i-join2', 1)}><use href="#spark"/></g></g>`
    + `<g ${a('i-pc')}>${bubble(`class="${GRAY}"`, false)}</g>`,
  anim: {
    'i-fmsg': fly(.04, .16, 465, 120, 55, 120, -20), 'i-got': vis(.16), 'i-mine': vis(0),
    'i-on': pop(.32),
    'i-up1': fly(.36, .48, 55, 160, 260, 150, -30), 'i-up2': fly(.40, .52, 55, 120, 260, 186, -30),
    'i-r1': pop(.48), 'i-r2': pop(.52),
    'i-q': pop(.66),
    'i-fmsg2': fly(.04, .16, 465, 120, 55, 120, -20), 'i-got2': vis(.16),
    'i-ask': pop(.33, .54), 'i-tap': tap(.46, 458, 177),
    'i-join': pop(.64), 'i-join2': pop(.64),
    'i-pc': fly(.66, .76, 55, 120, 260, 122, -30),
  } });

// 身近な不満（広告、電話番号）から入り、封の仕組み、流出、乗っ取り、記録、AI の順に見せる
const ORDER = ['ads', 'num', 'seal', 'leak', 'pw', 'trk', 'ai'];
S.sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id));

// ─── 並べる ─────────────────────────────────────────
const PLAYMARK = '<span class="playmark pointer-events-none absolute left-1/2 top-1/2 z-20 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-forest-600 text-white ring-4 ring-white/70 max-sm:h-11 max-sm:w-11 dark:bg-forest-300 dark:text-forest-950 dark:ring-black/40"><svg viewBox="1.1 0 24 24" class="h-7 w-7" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg></span>';
const lane = (sc, side) => {
  const tg = side === 'tg';
  const steps = [1, 2, 3].map((n) => `<li class="cap flex gap-2" data-step="${n}"><span class="font-semibold ${tg ? 'text-forest-600 dark:text-forest-300' : 'text-neutral-400'}">${n}</span><span>${t(`${sc.id}.${side}${n}`)}</span></li>`).join('');
  const vb = sc.id === 'pw' || sc.id === 'trk' ? '0 0 520 290' : '0 0 520 270';
  return `<figure class="rounded-2xl ${tg ? 'border-2 border-forest-600 dark:border-forest-300' : 'border border-neutral-200 dark:border-night-line'} p-5">
    <figcaption class="text-sm font-semibold ${tg ? 'text-forest-600 dark:text-forest-300' : 'text-neutral-500 dark:text-neutral-400'}">${tg ? 'Tegami' : t('ty')}</figcaption>
    <div class="relative mt-3"><svg class="flow w-full" viewBox="${vb}" role="img" aria-label="${[1, 2, 3].map((n) => t(`${sc.id}.${side}${n}`)).join(' ')}">${sc[side]}</svg>${tg ? PLAYMARK : ''}</div>
    <ol class="mt-4 space-y-2 text-sm sm:text-base">${steps}</ol>
  </figure>`;
};
document.getElementById('scenes').innerHTML = S.map((sc) => `
  <article id="sc-${sc.id}" class="scene" role="tabpanel" hidden>
    <h3 class="text-center text-2xl font-bold sm:text-3xl">${t(sc.id + '.h')}</h3>
    <p class="mx-auto mt-3 max-w-2xl text-center text-neutral-500 dark:text-neutral-400">${t(sc.id + '.t')}</p>
    <div class="mt-8 grid gap-6 md:grid-cols-2">${lane(sc, 'ty')}${lane(sc, 'tg')}</div>
    ${dev ? `<p class="mx-auto mt-6 max-w-3xl rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:bg-white/5 dark:text-neutral-300">${t(sc.id + '.spec')}</p>` : ''}
    ${dev && terms(sc.id).length ? `<details class="mx-auto mt-4 max-w-3xl px-1"><summary class="cursor-pointer text-sm font-bold text-neutral-700 dark:text-neutral-200">${t('terms.h')}</summary><dl class="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">${terms(sc.id).map(([w, d]) => `<dt class="font-semibold text-forest-700 dark:text-forest-300">${w}</dt><dd class="text-neutral-600 dark:text-neutral-300">${d}</dd>`).join('')}</dl></details>` : ''}
  </article>`).join('');
// 動画の再生の窓のような枠。絵の全体を囲み、下の端に、いまの場面の再生の位置を示す棒を出す。
const scenesEl = document.getElementById('scenes');
scenesEl.className = 'p-5 sm:p-8';
const frame = document.createElement('div');
frame.id = 'frame';
frame.className = 'mt-8 overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-lg ring-1 ring-black/5 dark:border-night-line dark:bg-night dark:ring-white/10';
frame.innerHTML = '<div class="h-1.5 w-full bg-neutral-200 dark:bg-night-line" aria-hidden="true"><div id="pbar" class="h-full w-full origin-left scale-x-0 bg-forest-600 dark:bg-forest-300"></div></div>';
scenesEl.parentNode.insertBefore(frame, scenesEl);
frame.insertBefore(scenesEl, frame.firstChild);
document.getElementById('chips').innerHTML = S.map((sc) => `<button type="button" role="tab" data-sc="${sc.id}" class="scene-tab">${t(sc.id + '.chip')}</button>`).join('');

// ─── 再生 ───────────────────────────────────────────
// 最初は止まった絵を見せる。場面は勝手に切り替わらない。動かすのは、絵をクリックした時（Enter と Space でも）だけ。
// もう一度クリックすると止まる。動きを減らす設定の人も同じ（最初から止まっている）。
const DUR = 14000;
let cur = null, anims = [], visible = false, paused = true, fresh = true;
const ICON = {
  play: '<svg viewBox="0 0 24 24" class="h-7 w-7" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
};
// 場面ごとの、絵の上にかぶせるボタン。止まっている間だけ、再生の印を出す。
document.querySelectorAll('#diff .scene > .grid').forEach((g) => {
  g.classList.add('relative');
  g.insertAdjacentHTML('beforeend', '<button type="button" class="playhit absolute inset-0 z-10 cursor-pointer rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest-600 dark:focus-visible:outline-forest-300"></button>');
});
function showButton() {
  document.querySelectorAll('#diff .playhit').forEach((b) => {
    b.setAttribute('aria-label', t(paused ? 'ctl.play' : 'ctl.pause'));
  });
  document.querySelectorAll('#diff .playmark').forEach((m) => { m.style.display = paused ? '' : 'none'; });
}
function run() {
  const go = visible && !paused;
  anims.forEach((x) => (go ? x.play() : x.pause()));
}
function toggle() {
  paused = !paused;
  if (!paused && fresh) { anims.forEach((x) => { x.currentTime = 0; }); fresh = false; }
  showButton(); run();
}
function play(id) {
  anims.forEach((x) => x.cancel()); anims = [];
  document.querySelectorAll('#diff .scene').forEach((el) => { el.hidden = el.id !== 'sc-' + id; });
  document.querySelectorAll('#diff .scene-tab').forEach((b) => {
    const on = b.dataset.sc === id;
    b.setAttribute('aria-selected', on);
    b.className = 'scene-tab';
  });
  cur = S.find((s) => s.id === id);
  const sc = document.getElementById('sc-' + id);
  sc.querySelectorAll('[data-a]').forEach((el) => {
    const f = cur.anim[el.dataset.a];
    if (f) anims.push(el.animate(f, { duration: DUR, iterations: Infinity }));
  });
  sc.querySelectorAll('.cap').forEach((li) => {
    const n = +li.dataset.step;
    const on = [[0, .3], [.3, .62], [.62, 1]][n - 1];
    anims.push(li.animate(K([[0, { opacity: on[0] === 0 ? 1 : .45 }], [Math.max(on[0] - .001, 0), { opacity: on[0] === 0 ? 1 : .45 }], [on[0], { opacity: 1 }], [on[1] - .001, { opacity: 1 }], [on[1], { opacity: on[1] === 1 ? 1 : .45 }], [1, { opacity: on[1] === 1 ? 1 : .45 }]]), { duration: DUR, iterations: Infinity }));
  });
  anims.push(document.getElementById('pbar').animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: DUR, iterations: Infinity, easing: 'linear' }));
  // 止まっている間は、3つの手順がそろった、最後の近くの絵を見せる。
  if (paused) { anims.forEach((x) => { x.currentTime = DUR * .9; }); fresh = true; }
  run();
}
document.getElementById('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.scene-tab'); if (!b) return;
  play(b.dataset.sc);
});
document.getElementById('scenes').addEventListener('click', (e) => { if (e.target.closest('.playhit')) toggle(); });
new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }, { threshold: 0.3 }).observe(root);
play(new URLSearchParams(location.search).get('scene') || S[0].id);
showButton();
window.tegamiFreeze = (p) => { paused = true; fresh = true; showButton(); anims.forEach((x) => { x.pause(); x.currentTime = DUR * p; }); };
