package main

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ==========================================================================
// Camada de autorização do WebSocket
// ==========================================================================
// Toda decisão de "fulano pode mandar isto para ciclano" passa por aqui, e só
// por aqui. A regra é a mesma do firestore.rules: quem participa da conversa
// (uid em chats/{id}.uids) fala com quem participa dela. O servidor nunca
// confia no chatId nem no destinatário que o cliente informa.
//
//   chat / digitando ....... o chatId do quadro (ou, em cliente antigo, a
//                            conversa direta entre os dois @)
//   chamada / webrtc ....... a conversa direta entre os dois @ — chamada é só
//                            1 para 1, e o chat.js já cria essa conversa antes
//                            de mostrar o botão de ligar
//
// O remetente precisa estar na conversa (checado aqui) e cada aba de destino
// também (checado pelo hub, com o uid de cada conexão).

var (
	ErrConversaInvalida = errors.New("identificador de conversa invalido")
	ErrSemConversa      = errors.New("conversa inexistente")
	ErrNaoParticipante  = errors.New("remetente nao participa da conversa")
	ErrMuitasConsultas  = errors.New("limite de consultas de conversa excedido")
)

// InfoConversa é o que a autorização precisa saber de chats/{id}.
type InfoConversa struct {
	Existe bool
	Tipo   string          // "direto" | "grupo"
	UIDs   map[string]bool // participantes (Firebase uid)
}

// Participa diz se o uid faz parte da conversa.
func (i InfoConversa) Participa(uid string) bool {
	return i.Existe && uid != "" && i.UIDs[uid]
}

// FonteDeConversas lê chats/{id}. Em produção é o Firestore (identity.go).
type FonteDeConversas interface {
	Conversa(ctx context.Context, chatID string) (InfoConversa, error)
}

type itemCacheConversa struct {
	info   InfoConversa
	expira time.Time
}

// Autorizador guarda em memória os participantes das conversas consultadas.
// Os participantes de uma conversa não mudam depois de criada (as regras do
// Firestore travam "uids"), então o cache positivo pode durar minutos. O
// negativo é curto: a conversa pode nascer um instante depois (o chat.js cria
// a conversa direta ao abrir a tela, antes do primeiro aviso).
type Autorizador struct {
	fonte FonteDeConversas

	mu         sync.Mutex
	cache      map[string]itemCacheConversa
	maxItens   int
	ttl        time.Duration
	ttlAusente time.Duration

	// Consultas que vão até o Firestore, por uid. Sem isto, um cliente
	// mandando chatIds aleatórios transformava cada quadro numa leitura paga.
	consultas *LimitadorPorChave

	agora func() time.Time
}

func NovoAutorizador(fonte FonteDeConversas) *Autorizador {
	return &Autorizador{
		fonte:      fonte,
		cache:      make(map[string]itemCacheConversa),
		maxItens:   50000,
		ttl:        5 * time.Minute,
		ttlAusente: 3 * time.Second,
		consultas:  NovoLimitadorPorChave(120, 60),
		agora:      time.Now,
	}
}

// Autorizar confere que remetenteUID participa de chatID e devolve os
// participantes, para o hub filtrar as abas de destino.
func (a *Autorizador) Autorizar(ctx context.Context, remetenteUID, chatID string) (InfoConversa, error) {
	if !idDeConversaValido(chatID) {
		return InfoConversa{}, ErrConversaInvalida
	}

	info, emCache := a.lerCache(chatID)
	if !emCache {
		if a.fonte == nil {
			return InfoConversa{}, ErrSemConversa
		}
		if !a.consultas.Permitir(remetenteUID) {
			return InfoConversa{}, ErrMuitasConsultas
		}
		var err error
		info, err = a.fonte.Conversa(ctx, chatID)
		if err != nil {
			return InfoConversa{}, err
		}
		a.gravarCache(chatID, info)
	}

	if !info.Existe {
		return InfoConversa{}, ErrSemConversa
	}
	if !info.Participa(remetenteUID) {
		return InfoConversa{}, ErrNaoParticipante
	}
	return info, nil
}

// Esquecer tira uma conversa do cache (conversa apagada, por exemplo).
func (a *Autorizador) Esquecer(chatID string) {
	a.mu.Lock()
	delete(a.cache, chatID)
	a.mu.Unlock()
}

func (a *Autorizador) lerCache(chatID string) (InfoConversa, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	item, ok := a.cache[chatID]
	if !ok || a.agora().After(item.expira) {
		return InfoConversa{}, false
	}
	return item.info, true
}

func (a *Autorizador) gravarCache(chatID string, info InfoConversa) {
	a.mu.Lock()
	defer a.mu.Unlock()
	agora := a.agora()
	if len(a.cache) >= a.maxItens {
		for id, item := range a.cache {
			if agora.After(item.expira) {
				delete(a.cache, id)
			}
		}
		if len(a.cache) >= a.maxItens {
			a.cache = make(map[string]itemCacheConversa)
		}
	}
	ttl := a.ttl
	if !info.Existe {
		ttl = a.ttlAusente
	}
	a.cache[chatID] = itemCacheConversa{info: info, expira: agora.Add(ttl)}
}
