const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const functions = require('firebase-functions');

// 1. Conexão com o Firebase

admin.initializeApp();

const db = admin.firestore();
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// 2. Guardião de Permissões
const verificarPermissao = (permissaoExigida) => {
    return async (req, res, next) => {
        try {
            const usuarioId = req.headers['x-usuario-id']; 
            if (!usuarioId) return res.status(401).json({ erro: 'ID não enviado.' });

            const docUser = await db.collection('usuarios').doc(usuarioId).get();
            if (!docUser.exists) return res.status(404).json({ erro: 'Usuário não cadastrado.' });

            const dados = docUser.data();
            if (dados.ativo === false) return res.status(403).json({ erro: 'Acesso bloqueado pela diretoria.' });
            if (dados[permissaoExigida] !== true) return res.status(403).json({ erro: 'Sem permissão.' });
            
            req.usuario = dados;
            next();
        } catch (erro) {
            res.status(500).json({ erro: 'Erro de comunicação.' });
        }
    };
};

// ==========================================
// ROTAS DE RELATÓRIOS E INTELIGÊNCIA (NOVO)
// ==========================================
app.get('/dashboard', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    try {
        // 1. Verifica os itens atuais para o Alerta de Reposição
        const itensSnap = await db.collection('itens').get();
        let alertas = [];
        
        itensSnap.forEach(doc => {
            const data = doc.data();
            if (data.quantidadeAtual <= data.estoqueMinimo) {
                alertas.push({ nome: data.nome, atual: data.quantidadeAtual, min: data.estoqueMinimo });
            }
        });

        // 2. Lê o Histórico para calcular o consumo dos últimos 30 dias
        const histSnap = await db.collection('historico').where('tipoMovimentacao', '==', 'Saída').get();
        
        const trintaDiasAtras = new Date();
        trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

        let consumo = {};
        
        histSnap.forEach(doc => {
            const data = doc.data();
            const dataTransacao = data.data.toDate(); // Converte data do Firebase para JS
            
            // Filtra em memória para evitar erros de indexação no Firebase do usuário
            if (dataTransacao >= trintaDiasAtras) {
                if (!consumo[data.itemId]) {
                    consumo[data.itemId] = { nome: data.nomeItem, totalGasto: 0 };
                }
                consumo[data.itemId].totalGasto += data.quantidadeRetirada;
            }
        });

        // Transforma num array e ordena do que mais gastou para o que menos gastou
        let rankingConsumo = Object.values(consumo).sort((a, b) => b.totalGasto - a.totalGasto);

        res.status(200).json({ alertas, rankingConsumo });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao gerar dados do painel.' });
    }
});

// ==========================================
// ROTAS DE USUÁRIOS
// ==========================================
app.get('/usuarios', verificarPermissao('masterAdmin'), async (req, res) => {
    const snapshot = await db.collection('usuarios').get();
    const usuarios = []; snapshot.forEach(doc => usuarios.push({ id: doc.id, ...doc.data() })); res.status(200).json(usuarios);
});

app.post('/usuarios', verificarPermissao('masterAdmin'), async (req, res) => {
    const { cpf, nome, email, ativo, masterAdmin, podeDarBaixa, podeCadastrarItens } = req.body;
    const docUser = await db.collection('usuarios').doc(cpf).get();
    if (docUser.exists) return res.status(400).json({ erro: 'Esse CPF já está cadastrado!' });
    await db.collection('usuarios').doc(cpf).set({ nome, email, cpf, ativo, masterAdmin, podeDarBaixa, podeCadastrarItens, criadoEm: new Date() });
    res.status(201).json({ mensagem: 'Cadastrado.' });
});

app.put('/usuarios/:cpf', verificarPermissao('masterAdmin'), async (req, res) => {
    const { cpf } = req.params; const { nome, email, ativo, masterAdmin, podeDarBaixa, podeCadastrarItens } = req.body;
    if (req.headers['x-usuario-id'] === cpf && (ativo === false || masterAdmin === false)) return res.status(400).json({ erro: 'Não pode remover seu próprio acesso Master!' });
    await db.collection('usuarios').doc(cpf).update({ nome, email, ativo, masterAdmin, podeDarBaixa, podeCadastrarItens }); res.json({ mensagem: 'Atualizado.' });
});

app.put('/usuarios/:cpf/status', verificarPermissao('masterAdmin'), async (req, res) => {
    const { cpf } = req.params; const { ativo } = req.body;
    if (req.headers['x-usuario-id'] === cpf) return res.status(400).json({ erro: 'Não se pode bloquear a si mesmo!' });
    await db.collection('usuarios').doc(cpf).update({ ativo }); res.json({ mensagem: 'Status alterado.' });
});

app.delete('/usuarios/:cpf', verificarPermissao('masterAdmin'), async (req, res) => {
    const { cpf } = req.params; if (req.headers['x-usuario-id'] === cpf) return res.status(400).json({ erro: 'Não se pode eliminar a si mesmo!' });
    await db.collection('usuarios').doc(cpf).delete(); res.json({ mensagem: 'Excluído.' });
});

// ==========================================
// ROTAS DE CATEGORIAS E ITENS
// ==========================================
app.get('/categorias', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const snapshot = await db.collection('categorias').get();
    const categorias = [];
    snapshot.forEach(doc => categorias.push({ id: doc.id, ...doc.data() }));
    res.status(200).json(categorias);
});

app.post('/categorias', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const nomeLimpo = req.body.nome.trim();
    const snapshot = await db.collection('categorias').get();
    if (snapshot.docs.some(doc => doc.data().nome.toLowerCase() === nomeLimpo.toLowerCase())) return res.status(400).json({ erro: 'Esta categoria já existe!' });
    
    const nova = await db.collection('categorias').add({ nome: nomeLimpo });
    res.status(201).json({ id: nova.id });
});

// ROTA NOVA: Editar o nome da categoria e atualizar os produtos ligados a ela
app.put('/categorias/:id', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const { id } = req.params;
    const { nome, nomeAntigo } = req.body;
    const nomeLimpo = nome.trim();

    // Verifica se já existe outra categoria com esse novo nome escolhido
    const snapshot = await db.collection('categorias').get();
    const jaExiste = snapshot.docs.some(doc => doc.id !== id && doc.data().nome.toLowerCase() === nomeLimpo.toLowerCase());
    if (jaExiste) return res.status(400).json({ erro: 'Já existe outra categoria com este nome!' });

    // 1. Atualiza o nome da categoria
    await db.collection('categorias').doc(id).update({ nome: nomeLimpo });

    // 2. Procura todos os itens que usavam o nome antigo e atualiza para o novo
    if (nomeAntigo) {
        const itensSnap = await db.collection('itens').where('categoria', '==', nomeAntigo).get();
        const batch = db.batch(); // O batch permite atualizar dezenas de itens ao mesmo tempo de forma super rápida
        itensSnap.forEach(doc => {
            batch.update(doc.ref, { categoria: nomeLimpo });
        });
        await batch.commit();
    }

    res.json({ mensagem: 'Categoria atualizada com sucesso.' });
});

app.delete('/categorias/:id', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    await db.collection('categorias').doc(req.params.id).delete();
    res.json({ mensagem: 'Deletada.' });
});

app.get('/itens', verificarPermissao('podeDarBaixa'), async (req, res) => {
    const snapshot = await db.collection('itens').get(); const itens = []; snapshot.forEach(doc => itens.push({ id: doc.id, ...doc.data() })); res.status(200).json(itens);
});

app.post('/itens', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const { nome, categoria, quantidadeAtual, estoqueMinimo } = req.body; const nomeLimpo = nome.trim();
    const snapshot = await db.collection('itens').where('categoria', '==', categoria).get();
    if (snapshot.docs.some(doc => doc.data().nome.toLowerCase() === nomeLimpo.toLowerCase())) return res.status(400).json({ erro: 'Este produto já existe nesta categoria!' });
    const novo = await db.collection('itens').add({ nome: nomeLimpo, categoria, quantidadeAtual: Number(quantidadeAtual), estoqueMinimo: Number(estoqueMinimo) }); res.status(201).json({ id: novo.id });
});

app.put('/itens/:id/abastecer', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const { id } = req.params; const { quantidadeAdicionada } = req.body;
    const itemRef = db.collection('itens').doc(id); const doc = await itemRef.get();
    if (!doc.exists) return res.status(404).json({ erro: 'Item não encontrado.' });
    const novaQuantidade = doc.data().quantidadeAtual + Number(quantidadeAdicionada);
    await itemRef.update({ quantidadeAtual: novaQuantidade });
    await db.collection('historico').add({ itemId: id, nomeItem: doc.data().nome, categoria: doc.data().categoria, quantidadeAdicionada: Number(quantidadeAdicionada), usuarioCpf: req.usuario.cpf, nomeUsuario: req.usuario.nome, tipoMovimentacao: 'Entrada', data: new Date() });
    res.json({ mensagem: 'Estoque abastecido', novoEstoque: novaQuantidade });
});

// ROTA NOVA: Editar nome do produto
app.put('/itens/:id/editar', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    const { id } = req.params;
    const { novoNome } = req.body;

    if (!novoNome || novoNome.trim() === "") return res.status(400).json({ erro: 'Nome inválido.' });

    const itemRef = db.collection('itens').doc(id);
    await itemRef.update({ nome: novoNome.trim() });
    
    res.json({ mensagem: 'Nome do produto atualizado com sucesso.' });
});

app.put('/itens/:id/baixa', verificarPermissao('podeDarBaixa'), async (req, res) => {
    const { id } = req.params; const { quantidadeRetirada } = req.body;
    const itemRef = db.collection('itens').doc(id); const doc = await itemRef.get();
    if (!doc.exists) return res.status(404).json({ erro: 'Item não encontrado.' });
    const novaQuantidade = doc.data().quantidadeAtual - Number(quantidadeRetirada);
    if (novaQuantidade < 0) return res.status(400).json({ erro: 'Estoque insuficiente.' });
    await itemRef.update({ quantidadeAtual: novaQuantidade });
    await db.collection('historico').add({ itemId: id, nomeItem: doc.data().nome, categoria: doc.data().categoria, quantidadeRetirada: Number(quantidadeRetirada), usuarioCpf: req.usuario.cpf, nomeUsuario: req.usuario.nome, tipoMovimentacao: 'Saída', data: new Date() });
    let alerta = (novaQuantidade <= doc.data().estoqueMinimo);
    res.json({ restante: novaQuantidade, alerta });
});

app.delete('/itens/:id', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    await db.collection('itens').doc(req.params.id).delete(); res.json({ mensagem: 'Deletado.' });
});

module.exports = app;